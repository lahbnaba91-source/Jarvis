import warnings; warnings.filterwarnings("ignore")
import time
t0 = time.time()
print("loading faster-whisper small.en...", flush=True)
from faster_whisper import WhisperModel
m = WhisperModel("small.en", device="cpu", compute_type="int8")
print(f"whisper ready in {time.time()-t0:.1f}s", flush=True)

print("loading kokoro (bm_lewis)...", flush=True)
import os
for lib in ("/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1", "/usr/lib/libespeak-ng.so.1"):
    if os.path.exists(lib):
        os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = lib
        break
from kokoro import KPipeline
pipe = KPipeline(lang_code="b")
print(f"kokoro ready in {time.time()-t0:.1f}s total", flush=True)
print("MODELS_WARM_OK", flush=True)
