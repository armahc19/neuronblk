const PYODIDE_VERSION = "0.27.7";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

type PyodideInterface = import("pyodide").PyodideInterface;

let pyodidePromise: Promise<PyodideInterface> | null = null;

/** Injected before user code — async input(), AI/HTTP stubs for browser execution. */
const RUNTIME_PREAMBLE = `
import builtins
from pyodide.ffi import run_sync

def _neuronblk_input(prompt=""):
    return run_sync(neuronblk_input(str(prompt) if prompt is not None else ""))

builtins.input = _neuronblk_input

class _NeuronAI:
    @staticmethod
    def chat(prompt):
        print(f"[AI stub] chat({prompt!r})")
        return f"[stub] Response to: {prompt}"

    @staticmethod
    def classify(text):
        print(f"[AI stub] classify({text!r})")
        return "unknown"

    @staticmethod
    def image(prompt):
        print(f"[AI stub] image({prompt!r})")
        return f"[stub image for: {prompt}]"

ai = _NeuronAI()

class _RequestsResponse:
    def __init__(self, url, method="GET"):
        self.url = url
        self.status_code = 200
        self.text = '{"stub": true, "note": "HTTP requests are stubbed in browser execution"}'
        self.ok = True

class _Requests:
    @staticmethod
    def get(url, **kwargs):
        print(f"[HTTP stub] GET {url}")
        return _RequestsResponse(url, "GET")

    @staticmethod
    def post(url, json=None, **kwargs):
        print(f"[HTTP stub] POST {url} body={json!r}")
        return _RequestsResponse(url, "POST")

requests = _Requests()
`;

export type RunPythonOptions = {
  code: string;
  onInput: (prompt: string) => Promise<string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onStatus?: (msg: string) => void;
  timeoutMs?: number;
};

export type RunPythonResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
};

async function getPyodide(onStatus?: (msg: string) => void): Promise<PyodideInterface> {
  if (typeof window === "undefined") {
    throw new Error("Python execution is only available in the browser.");
  }
  if (!pyodidePromise) {
    onStatus?.("Loading Python runtime (first run downloads ~10 MB)…");
    pyodidePromise = import("pyodide").then(({ loadPyodide }) =>
      loadPyodide({ indexURL: PYODIDE_INDEX_URL }),
    );
  }
  return pyodidePromise;
}

export async function runPython(options: RunPythonOptions): Promise<RunPythonResult> {
  const start = performance.now();
  const { code, onInput, onStdout, onStderr, onStatus, timeoutMs = 30_000 } = options;

  let stdout = "";
  let stderr = "";

  try {
    const pyodide = await getPyodide(onStatus);

    pyodide.setStdout({
      batched: (msg: string) => {
        stdout += msg + "\n";
        onStdout?.(msg);
      },
    });
    pyodide.setStderr({
      batched: (msg: string) => {
        stderr += msg + "\n";
        onStderr?.(msg);
      },
    });

    onStatus?.("Running…");

    const fullCode = `${RUNTIME_PREAMBLE}\n${code}`;
    const globals = pyodide.runPython(`dict(__name__="__main__")`);
    globals.set("neuronblk_input", (prompt: string) => onInput(prompt ?? ""));

    const runPromise = pyodide.runPythonAsync(fullCode, { globals });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Execution timed out (30s limit)")), timeoutMs);
    });

    try {
      await Promise.race([runPromise, timeoutPromise]);
    } finally {
      globals.destroy();
    }

    return {
      success: true,
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
      durationMs: performance.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
      durationMs: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
