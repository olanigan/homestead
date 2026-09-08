"""Shared helpers for the Homestead Colab showcase notebooks (01, 02, ...).

Trimmed to exactly what the notebooks in this directory need: clone this repo
into a fresh Colab VM, attempt a real Homestead gateway build, and fall back
to a plain llama.cpp server the moment the gateway doesn't come up healthy
with the requested model actually registered. See examples/colab/README.md
for the "why" behind this fallback design.
"""

import os
import subprocess
import time

REPO_URL = "https://github.com/olanigan/homestead.git"
REPO_DIR = "/content/homestead"


def clone_repo():
    """Clone this repo into /content if it isn't already there. Idempotent."""
    if not os.path.isdir(REPO_DIR):
        subprocess.run(
            ["git", "clone", "--quiet", "--depth", "1", REPO_URL, REPO_DIR],
            check=True,
        )
    return REPO_DIR


def try_build_gateway(timeout=300):
    """Attempt to build the real Homestead gateway (bun install && bun run
    build:ts). Returns True on success, False on any failure -- this never
    raises, because a failed/skipped build is the expected llama.cpp-fallback
    path, not an error condition. Call this once per notebook run; the result
    is reused across every model in a battle, only the served model changes.
    """
    try:
        # NOTE: `curl ... | bash` masks curl's own exit code -- if curl fails
        # (network blip, bun.sh unreachable), bash still runs on empty stdin
        # and exits 0. So this step's exit code alone can't be trusted; the
        # explicit `bun --version` check right after is what actually proves
        # the install worked.
        subprocess.run(
            "curl -fsSL https://bun.sh/install | bash",
            shell=True, capture_output=True, timeout=120,
        )
        bun_env = os.environ.copy()
        bun_env["PATH"] = f"{os.path.expanduser('~/.bun/bin')}:" + bun_env["PATH"]
        subprocess.run(
            ["bun", "--version"], env=bun_env,
            check=True, capture_output=True, timeout=15,
        )
        subprocess.run(
            ["bun", "install"], cwd=REPO_DIR, env=bun_env,
            check=True, capture_output=True, timeout=timeout,
        )
        subprocess.run(
            ["bun", "run", "build:ts"], cwd=REPO_DIR, env=bun_env,
            check=True, capture_output=True, timeout=timeout,
        )
        return True
    except Exception as e:
        print(f"Gateway build failed ({e}) -- will use the llama.cpp fallback instead.")
        return False


def wait_for_health(base_url, timeout=60, require_data=True):
    """Poll <base_url>/models until it responds. If require_data is True
    (the gateway case), an empty `data: []` counts as *not* healthy -- an
    empty registry means the model we asked for was never actually
    registered, which is exactly the case serve_model() needs to detect to
    trigger its llama.cpp fallback."""
    import requests

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(f"{base_url}/models", timeout=3)
            if r.ok:
                body = r.json()
                if not require_data or body.get("data"):
                    return body
        except requests.exceptions.RequestException:
            pass
        time.sleep(2)
    return None


def start_llamacpp_server(model_path, port=8080):
    subprocess.run(
        ["pip", "install", "-q", "llama-cpp-python[server]",
         "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cu121"],
        check=True,
    )
    proc = subprocess.Popen(
        ["python", "-m", "llama_cpp.server",
         "--model", model_path, "--n_gpu_layers", "-1", "--port", str(port)],
        stdout=open(f"/content/llamacpp-{port}.log", "w"),
        stderr=subprocess.STDOUT,
    )
    return proc, f"http://127.0.0.1:{port}/v1"


def start_gateway_server(model_path=None):
    """Start `homestead provider start` from the built repo.

    Model registration: `homestead import <path>` (confirmed via `--help`
    against a real build -- positional path arg, no extra flags needed)
    registers the GGUF and it does show up in `/v1/models` afterwards,
    verified end-to-end against a dummy file in a real build of this repo.
    If that step ever regresses upstream, serve_model()'s health check below
    still requires /v1/models to list the model and falls back to llama.cpp
    automatically if it doesn't.
    """
    bun_env = os.environ.copy()
    bun_env["PATH"] = f"{os.path.expanduser('~/.bun/bin')}:" + bun_env["PATH"]
    if model_path:
        subprocess.run(
            ["bun", "run", "dist/homestead.js", "import", model_path],
            cwd=REPO_DIR, env=bun_env, capture_output=True, timeout=60,
        )
    proc = subprocess.Popen(
        ["bun", "run", "dist/homestead.js", "provider", "start"],
        cwd=REPO_DIR, env=bun_env,
        stdout=open("/content/gateway.log", "w"),
        stderr=subprocess.STDOUT,
    )
    return proc, "http://127.0.0.1:3030/v1"


def serve_model(model_path, gateway_ok, port=8080):
    """Try the gateway path if gateway_ok, verify it actually reports our
    model as healthy, and fall back to llama.cpp on any failure.

    Returns (proc, base_url, models_json, used_gateway).
    """
    if gateway_ok:
        proc, base_url = start_gateway_server(model_path)
        models = wait_for_health(base_url, timeout=45, require_data=True)
        if models:
            return proc, base_url, models, True
        print("Gateway did not report a healthy registered model in time -- falling back to llama.cpp.")
        proc.terminate()
    proc, base_url = start_llamacpp_server(model_path, port=port)
    models = wait_for_health(base_url, timeout=90, require_data=True)
    return proc, base_url, models, False


def pick_and_download_gguf(
    repo_id,
    quant_prefs=("Q4_K_M", "Q4_K_S", "Q4_0", "IQ4", "Q5_K_M", "Q8_0"),
    local_dir="/content/models",
):
    """List a GGUF repo's actual files and pick the first one matching a
    quant preference, instead of hardcoding an exact filename -- HF repos'
    quant-suffix naming shifts release to release, and guessing wrong just
    404s. Falls back to the alphabetically-first .gguf file if none of the
    preferred quant tags are present.
    """
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi()
    files = [f for f in api.list_repo_files(repo_id) if f.endswith(".gguf")]
    if not files:
        raise RuntimeError(f"No .gguf files found in {repo_id}")
    chosen = None
    for pref in quant_prefs:
        matches = sorted(f for f in files if pref.lower() in f.lower())
        if matches:
            chosen = matches[0]
            break
    if chosen is None:
        chosen = sorted(files)[0]
    print(f"{repo_id}: picked {chosen} (out of {len(files)} .gguf files)")
    return hf_hub_download(repo_id=repo_id, filename=chosen, local_dir=local_dir)
