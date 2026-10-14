---
name: aviation-explainer-video
description: Make a narrated, animated vertical explainer video (MP4) on any aviation topic from a carousel, notes or a topic name, using the house narrator voice, code-drawn animation, word-timed captions and a synced soundtrack.
---

# Aviation Explainer Video

Produces a 1080×1920, 30 fps MP4 (2–3.5 min) in the "illustrated explainer" style: night-navy palette, glowing lights, white aircraft with a violet accent. It has a male narrator, burned-in word-timed captions, chapter labels, a music bed and sound effects. The final file is HEVC under 30 MB so it plays and sends from an iPhone. Everything is drawn with code in a canvas and rendered frame by frame. There are no image generators and no stock art.

## Standing rules from Luis

1. **Voice is fixed.** Always use the house narrator: Kokoro voice blend `am_michael*0.7+am_fenrir*0.3`, speed 0.95, with the clarity chain on (built into `tts_av.py`). Don't change the voice, blend or tone unless he asks.
2. **Pronunciation is checked before recording.** Run the audit and fix every flagged word: heteronyms, acronyms, numbers and unknown words. Stress and accent errors are the main complaint to avoid.
3. **Never narrate the same thing twice.** Each fact is spoken once. A recap is visual (a table or card on screen) plus at most one closing line that adds something new. Don't re-explain items in a "pattern", "summary" or "recap" chapter. If two cases share a meaning, say it once ("in the air or on the ground").
4. **Deliver a real video file,** not an HTML page. Keep it under 30 MB so it can be sent.
5. **Facts must be right.** Verify against FAA sources (AIM, PHAK, AFH, 14 CFR) with WebSearch/WebFetch before writing. If the source material (such as a carousel) is wrong or incomplete, fix or extend it and say so. List the sources in the final message.

## Workflow

Create a task list first, and tell Luis in one line what you're making. He works from an iPhone, so keep updates short.

### 1. Set up (once per session)

Run the `setup.sh` block from the Appendix with bash. Then write every Appendix `## File:` block into `$W` byte for byte (use the Write tool with the block content): `g2p_av.py`, `tts_av.py`, `check_script.py`, `engine.js`, `render.js`, `soundtrack.py`, `film_template.html`. Create one folder per video: `$W/<slug>/`. Shell state does not persist, so start every command with `W=<absolute path>`.

The environment notes:
- pip is usually blocked. numpy, scipy, onnxruntime and Pillow are preinstalled.
- GitHub downloads work.
- Playwright and Chromium are preinstalled (`/opt/npm-tools/node_modules/playwright`, `/opt/pw-browsers`).
- ffmpeg has libx265.

### 2. Research and plan (the fact ledger)

Verify every fact. Then write a **fact ledger**: a numbered list of every fact the video teaches, each assigned to exactly one script line. If a fact appears twice in the ledger, cut one. The usual structure is 5–8 chapters with 1–3 word titles:

1. **Hook:** a concrete scenario in second person ("You're ten miles out… your radio dies").
2. **The thing itself:** what it is and how it works.
3. **Details acted out:** one line per case, each with its own animation.
4. **The organizing idea or mnemonic:** only if it adds a new angle. Better still, teach it *before* the details so the details reinforce it. Never list the details again here.
5. **What to do:** the pilot's action.
6. **Recap card:** a table on screen. The narration doesn't read the table. Use one closing line about why it matters.

### 3. Write `script.json`

```json
[{"title": "Radio silence", "lead": 1.2, "lines": ["You're ten miles out, about to call the tower.", "..."]},
 {"title": "In the air", "allow_repeat": ["steady green"], "lines": ["..."]}]
```

- One visual idea per line. Lines ≤ 30 words, sentences ≤ 20 words. Use plain spoken English, short sentences and "you".
- Write numbers as digits, the way pilots write them: `7600`, `runway 27L`, `118.3`, `3,500 ft`, `65 kts`, `N123AB`. The voice speaks them correctly: squawk, runway, heading and wind numbers digit by digit (`wind 270` → "two seven zero"), `FL350` → "flight level three five zero", `1500Z` → "one five zero zero zulu", frequencies as "one one eight point three", tail numbers in the phonetic alphabet, and a 4-digit year after "in/since/by…" as a year (`in 1903` → "nineteen oh three"). Captions show the digits.
- Aim for 300–500 words (2–3.5 min).
- `lead` is the silence before a chapter. The default is 1.6 s. Use about 3 s after a chapter that ends on a title card.

### 4. Check the script (both checks must be clean)

```bash
cd $W && python3 check_script.py <slug>/script.json   # repeated phrases, near-duplicate lines, long sentences
python3 g2p_av.py <slug>/script.json                  # every word whose pronunciation is a guess or a choice
```

- **Repetition:** rewrite until no explanation repeats. `allow_repeat` is only for names that must recur (such as signal names), never for meanings.
- **Pronunciation:** go through each flagged line.
  - `heteronym:*`: confirm VERB/NOUN matches the meaning ("runway in **use**" is the noun, /jus/).
  - `acronym-letters`: confirm it's said letter by letter (ATC, VFR). If it's said as a word, add it to `AV_ACR`.
  - `number`: confirm the expansion.
  - `UNKNOWN`/`compound`/`stem-*`: verify.
  - Fix with an entry in `AV_WORDS`/`AV_ACR`, or inline in the script: `[METAR](/mˈitɑɹ/)`.
- **Phoneme alphabet (misaki US):**
  - Diphthongs: A=eɪ, I=aɪ, O=oʊ, W=aʊ, Y=ɔɪ.
  - Stress marks: ˈ primary, ˌ secondary.
  - Other symbols: ᵊ syllabic, ɾ flap, ᵻ reduced i, ɹ r.
  - Copy patterns from similar dictionary words: `python3 -c "from g2p_av import raw; print(raw('word'))"`.
  - Stress goes right before the stressed vowel's syllable, as in `dˈWnwˌɪnd`. Pilots say DOWN-wind, not down-WIND.

### 5. Record the narration

```bash
python3 tts_av.py <slug>/script.json <slug>     # -> <slug>/narration.wav (48 kHz) + <slug>/timeline.json
```

- Each line is voiced in one pass, so sentences flow naturally into each other. (A sentence too long for one model pass, over 480 phonemes, is voiced in clause-sized pieces and rejoined into one timeline sentence, so `st(s,l,k)` indices don't shift. `check_script.py` should have flagged it first.)
- The model returns exact timings, so `timeline.json` has every sentence and every caption word with start/end times.
- The clarity chain:
  - low cut at 75 Hz
  - −2.5 dB at 260 Hz
  - +3 dB at 3.2 kHz
  - +2 dB air shelf
  - de-esser
  - 2.5:1 leveling

### 6. Animate: `<slug>/film.html`

Link the shared files: `ln -s ../engine.js ../fonts <slug>/`. Write `film.html` from the template in the Appendix. Read the **engine API** section below.

Scene rules:
- **One function per chapter.** Each scene function paints the whole frame (start with `sky()` or `gridBG()`). It may be called after its chapter ends, during crossfades, so it must show a sensible end state.
- **Per-line elements** use `lineA(s,l,t)` for alpha (fade in at the line, out at the next line).
- **Sync to speech:** sentence starts use `st(s,l,k)`. Specific words use `at(s,l,'word')`, for example to pop "STOP" exactly when "Stop" is said.
- **Layout zones:**
  - chapter label: y < 200
  - key-term card (`infoCard`): y 250–460
  - main action: y 480–1450
  - captions: y ≈ 1660 (keep y > 1500 clear)
- **Each line gets its own visual beat:** a motion, a reveal or a state change. Avoid static slides.
- **Pick the right view:**
  - side view (`planeSide`) for flight paths, approaches and climbs
  - top-down (`planeTop`, `runwayTop`, `pathAt`) for taxiing and airport layout
  - front view (`planeFront`) for wing rocking and control surfaces
  - instruments (`gauge`, `attitude`) for cockpit topics
  - `gridBG` with cards and tables for concepts and recaps
- **Motion is math.** Ease with `eio`/`eout`, pop-ins with `pop`, and follow waypoints with `pathAt` (smooth heading). An oval pattern with `dir = clamp(-sinθ*2.6)` gives a pseudo-3D turn.
- **Lights:**
  - `blink('steady'|'flash'|'alt', t-t0, col, col2)` sets the flashing pattern.
  - `beam(x0,y0,x1,y1,col,i,a)` draws a glowing cone.
  - `glow(x,y,r,col,a)` adds additive light.
- **Zooming between scales** (for example from a whole aircraft into an instrument): translate/scale the ctx around a focus point inside one scene function. Fade out objects that would fly into frame during the zoom.
- **Sound events:** register them in `FILM.setup()` with `ev(time,'type',{d})`. Chapter whooshes are added automatically. Types: `gun pop tick click chime beep ping static stamp flare title boom shimmer swoosh zoom stopsign alarm engine{d} wind{d}`.

### 7. Check stills (required before the full render)

Start a server, render stills for every line (about 30–40 timestamps, each about 0.5–1.5 s after the line starts), and tile them into contact sheets. Look at every sheet. Check for:
- overlaps
- text running off screen or clipped
- objects flying through the frame during zooms or crossfades
- empty or static frames
- labels appearing before the word is said
- wrong-colored lights

Fix the problems, then re-render only the problem stills once.

```bash
cd $W/<slug> && (nohup python3 -m http.server 8790 --bind 127.0.0.1 >/dev/null 2>&1 &); cd $W
node render.js <slug> 8790 stills 3,6.5,10,...
python3 -c "from PIL import Image;import glob;fs=sorted(glob.glob('<slug>/stills/*.png'));w,h=360,640
for p in range(0,len(fs),10):
  s=Image.new('RGB',(w*5,h*2))
  for i,f in enumerate(fs[p:p+10]): s.paste(Image.open(f).convert('RGB').resize((w,h)),((i%5)*w,(i//5)*h))
  s.save(f'<slug>/sheet{p//10}.jpg',quality=86)"
```

### 8. Render, mix, encode (run long jobs in the background)

Rendering speed is about 0.15 s per frame, so a 3-minute video takes about 14 minutes. Run it with nohup and poll the log for `VIDEO DONE`.

Polling rules:
- Don't use `pgrep -f "render.js"`. It matches the waiting shell itself and never exits.
- Long foreground ffmpeg jobs can be killed when a message arrives, so always background them.

```bash
nohup node render.js <slug> 8790 events > <slug>/ev.log 2>&1
nohup node render.js <slug> 8790 video <slug>/video_only.mp4 > <slug>/render.log 2>&1 &
python3 soundtrack.py <slug> --mood bright        # bright | calm | tense  -> <slug>/mix.wav (music ducks under the voice)
# STOP: poll <slug>/render.log until it prints VIDEO DONE before running anything below (ffprobe on a half-written mp4 fails)
# encode: total ≈ 27 MB. Video kbps = 27*8192/duration_s - 128
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 <slug>/video_only.mp4); VB=$(python3 -c "print(int(27*8192/$DUR-128))")
nohup ffmpeg -y -loglevel error -i <slug>/video_only.mp4 -i <slug>/mix.wav -map 0:v -map 1:a -vf hqdn3d=2:2:3:3 \
  -c:v libx265 -preset fast -b:v ${VB}k -x265-params "log-level=error:vbv-maxrate=$((VB*2)):vbv-bufsize=$((VB*4))" -tag:v hvc1 -pix_fmt yuv420p \
  -af "loudnorm=I=-15:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 128k -shortest -movflags +faststart <slug>/<Title-Name>.mp4 > <slug>/enc.log 2>&1 &
```

If one section needs fixing after the full render, re-render only that time range, splice it into the H.264 intermediate, then run the single final encode above again. Don't concatenate separately encoded HEVC/AAC pieces, because loudnorm and the AAC frames glitch at the seams.

```bash
nohup node render.js <slug> 8790 video <slug>/part.mp4 FROM TO > <slug>/part.log 2>&1 &     # wait for VIDEO DONE
nohup ffmpeg -y -loglevel error -i <slug>/video_only.mp4 -i <slug>/part.mp4 -filter_complex \
  "[0:v]trim=0:FROM,setpts=PTS-STARTPTS[a];[0:v]trim=TO,setpts=PTS-STARTPTS[c];[a][1:v][c]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p <slug>/video_fixed.mp4 > <slug>/splice.log 2>&1 &
# then mv video_fixed.mp4 video_only.mp4 and re-run the encode
```

### 9. Verify and deliver

- Check streams and duration with `ffprobe` (hevc/hvc1 + aac).
- Extract 8–12 frames from the final file and look at them.
- Check that loudness is about −15 LUFS: `ffmpeg -hide_banner -i <slug>/<Title-Name>.mp4 -af ebur128 -f null - 2>&1 | grep -A1 'Integrated'`.
- Send with `SendUserFile` (≤ 30 MB).
- Final message: what's in the video in a few bullets, any facts you corrected or added beyond the source, and the source links.

## Engine API (`engine.js`)

- **Timing:** `TL`, `sc(s)`, `ln(s,l)`, `st/se/sd(s,l,k)` (sentence k of line l), `ls/le(s,l)` (line start/end), `at(s,l,'word',n)` (when a word is spoken), `lineIdx(s,t)`, `lineA(s,l,t)`, `trS(k)` (chapter crossfade start), `ev(t,type,extra)`.
- **Easing:** `clamp lerp sm eio eout eob ap(s,d) pop(s,d) win(t,a,b,fi,fo) rng(seed) mix shade rgba`. Always set alpha with `A(a)` so crossfades work.
- **Drawing:** `glow circle text(s,x,y,{size,w,font,color,align,ls,stroke,glow,rot,a}) textW fit wrap pill callout(label,px,py,lx,ly,a,o) arrow reticle dashed`.
- **Lights:** `blink(pattern,tl,col,col2)` → `{col,i}`; `lamp(x,y,r,S,a,baseCol)`; `beam(x0,y0,x1,y1,col,i,a,{w0,w1,src,tgt})`.
- **World:**
  - `sky(t,day,hor)`: day 0 is night with stars and city lights, 1 is clear day.
  - `gridBG(t)`, `cloud(x,y,s,a,col,dark)`, `windsock(x,y,s,t,dirDeg,strength)`, `runwaySide(t,{y,x0,x1,red,lights})`, `tower(x,baseY,s,t)` → `{gx,gy}`, `runwayTop(x0,y0,x1,y1,['9','27'])`, `pathAt(pts,f)` → `{x,y,h}`.
- **Aircraft:**
  - `planeSide(x,y,s,dir,pitch,t,{ll,acc,flaps,gear,a})`
  - `planeTop(x,y,s,heading,t,{alt,ll,acc,a})`
  - `planeFront(x,y,s,roll,t,{ail,rud,nav,land,a})`
- **Instruments:** `gauge(x,y,r,value,{min,max,label,unit,arcs,major,startDeg,sweepDeg})`, `attitude(x,y,r,pitchDeg,rollDeg,a)`.
- **Cards:** `cardBox`, `infoCard(eyebrow,main,a,{icon,tm,border,y,h})`, `sunIcon`, `moonIcon`, `stopSign`, `table(x,y,w,head,rows,{t,t0,rowH,colW,headCol,firstCol,size})`.
- **Colors** (`COL`): `white muted gold amber blue ink green red lamp accent sky`. Fonts are Outfit (display) and Figtree (body).

# Appendix: files

## File: setup.sh
Run once per session (idempotent). Downloads the timed voice model, voices, pronunciation dictionary and fonts. All of them are pinned and checksum-verified, and the script stops with a `setup:` message on any failure.
```bash
#!/usr/bin/env bash
# Fetch the pinned voice model, pronunciation dictionary, vocab and fonts into $W (default ./avvid).
# Fails loudly: any bad download, checksum mismatch or missing dependency stops the run with a message.
set -euo pipefail
W=${W:-$PWD/avvid}; mkdir -p "$W/models" && cd "$W"

# Pinned upstream versions (bump deliberately, never float on HEAD)
MISAKI_SHA=fba1236595f2d2bf21d414ba6e57d25256afada3
KOKORO_ONNX_SHA=3596b26764286a7de9d90c363e988d50578918e5
GFONTS_SHA=67bc647ce1910e92f461bcc82aae30f21d21a9cc
MODEL_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx
MODEL_SHA256=beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a
VOICES_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
VOICES_SHA256=bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d

die() { echo "setup: $*" >&2; exit 1; }
sha_ok() { [ -s "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ]; }
fetch() { # url dest sha256 -- skip if already verified, else download to .part, verify, then move into place
  sha_ok "$2" "$3" && return 0
  rm -f "$2"; curl -fsSL --retry 3 -o "$2.part" "$1" || { rm -f "$2.part"; die "download failed: $1"; }
  sha_ok "$2.part" "$3" || { rm -f "$2.part"; die "checksum mismatch for $1"; }
  mv "$2.part" "$2"
}
clone_at() { # repo dir sha [sparse paths...]
  local repo=$1 dir=$2 sha=$3; shift 3
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then return 0; fi
  rm -rf "$dir"; git init -q "$dir"; git -C "$dir" remote add origin "https://github.com/$repo.git"
  if [ $# -gt 0 ]; then git -C "$dir" sparse-checkout set "$@"; fi
  git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$sha" || die "fetch failed: $repo@$sha"
  git -C "$dir" checkout -q FETCH_HEAD || die "checkout failed: $repo@$sha"
}

fetch "$MODEL_URL" models/kokoro-v1.0-timed.onnx "$MODEL_SHA256"
fetch "$VOICES_URL" models/voices-v1.0.bin "$VOICES_SHA256"
clone_at hexgrad/misaki misaki "$MISAKI_SHA"
clone_at thewh1teagle/kokoro-onnx kokoro-onnx "$KOKORO_ONNX_SHA"
for f in misaki/misaki/data/us_gold.json misaki/misaki/data/us_silver.json kokoro-onnx/src/kokoro_onnx/config.json; do
  [ -s "$f" ] || die "expected file missing after clone: $f (upstream layout changed?)"
done
if [ ! -s fonts/Outfit.ttf ] || [ ! -s fonts/Figtree.ttf ]; then
  clone_at google/fonts gfonts "$GFONTS_SHA" ofl/outfit ofl/figtree
  mkdir -p fonts && cp "gfonts/ofl/outfit/Outfit[wght].ttf" fonts/Outfit.ttf && cp "gfonts/ofl/figtree/Figtree[wght].ttf" fonts/Figtree.ttf
fi

python3 -c "import numpy, scipy, onnxruntime, PIL" || die "missing python deps: pip install numpy scipy onnxruntime pillow"
echo 'python ok'
command -v ffmpeg >/dev/null || die "ffmpeg not installed"
ENC=$(ffmpeg -hide_banner -encoders 2>/dev/null)            # captured first: grep -q on a pipe trips pipefail via SIGPIPE
grep -q libx264 <<<"$ENC" || die "ffmpeg lacks libx264 (render.js needs it)"
grep -q libx265 <<<"$ENC" || die "ffmpeg lacks libx265 (HEVC final encode needs it)"
echo 'ffmpeg ok'
ls -la models fonts
```

## File: g2p_av.py
Pronunciation: misaki US lexicon + aviation words/acronyms + heteronyms + numbers. Add new aviation words to AV_WORDS / AV_ACR.
```python
"""Aviation-aware English G2P for Kokoro: misaki US lexicon + aviation lexicon + heteronyms + numbers + acronyms.

phonemize_sentence(text) -> (phoneme_string, words)   words = [{text, ps, src, a, b}] (a,b = char span in ps)
caption_text(text) -> text with [word](/phonemes/) overrides stripped to 'word'
audit(lines) -> prints every word that did not come straight from the gold dictionary
Inline override anywhere in a script line:  [METAR](/mˈitɑɹ/)
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.environ.get('MISAKI_DATA') or os.path.join(HERE, 'misaki/misaki/data')
GOLD = json.load(open(f'{D}/us_gold.json'))
SILVER = json.load(open(f'{D}/us_silver.json'))
VOWELS = set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ')
P, S2 = 'ˈ', 'ˌ'

# Word-like aviation acronyms (said as a word, not letter by letter)
AV_ACR = {
    'METAR': 'mˈitɑɹ', 'TAF': 'tˈæf', 'NOTAM': 'nˈOtˌæm', 'ATIS': 'ˈAtɪs', 'CTAF': 'sˈitˌæf', 'PIREP': 'pˈIɹˌɛp',
    'SIGMET': 'sˈɪɡmˌɛt', 'AIRMET': 'ˈɛɹmˌɛt', 'UNICOM': 'jˈunəkˌɑm', 'TCAS': 'tˈikˌæs', 'ASOS': 'ˈAsˌɑs', 'AWOS': 'ˈAwˌɑs',
    'TRACON': 'tɹˈAkˌɑn', 'VASI': 'vˈɑzi', 'PAPI': 'pˈæpi', 'RNAV': 'ˈɑɹnˌæv', 'NEXRAD': 'nˈɛksɹˌæd', 'LORAN': 'lˈɔɹˌæn',
    'ADIZ': 'ˈAdˌɪz', 'LAHSO': 'lˈɑsO', 'NORDO': 'nˈɔɹdO', 'SID': 'sˈɪd', 'STAR': 'stˈɑɹ', 'NASA': 'nˈæsə', 'NOAA': 'nˈOə',
    'LIDAR': 'lˈIdˌɑɹ', 'RADAR': 'ɹˈAdˌɑɹ', 'SCUD': 'skˈʌd', 'CAVOK': 'kˈævˌOkˌA', 'WAAS': 'wˈɑs', 'ELT': 'ˌi ˌɛl tˈi',
}
# Aviation words missing from (or mis-stressed in) the general dictionary
AV_WORDS = {
    'niner': 'nˈInəɹ', 'cessna': 'sˈɛsnə', 'pitot': 'pˈitO', 'glideslope': 'ɡlˈIdslˌOp', 'glidepath': 'ɡlˈIdpˌæθ',
    'localizer': 'lˈOkəlˌIzəɹ', 'beechcraft': 'bˈiʧkɹˌæft', 'downwind': 'dˈWnwˌɪnd', 'upwind': 'ˈʌpwˌɪnd',
    'empennage': 'ˈɛmpənɪʤ', 'flaperon': 'flˈæpəɹˌɑn', 'stabilator': 'stˈAbəlˌAɾəɹ', 'airframe': 'ˈɛɹfɹˌAm',
    'preflight': 'pɹˈiflˌIt', 'runup': 'ɹˈʌnˌʌp', 'checkride': 'ʧˈɛkɹˌId', 'go-around': 'ɡˈO əɹˌWnd', 'touchdown': 'tˈʌʧdˌWn',
    'squawk': 'skwˈɔk', 'squawking': 'skwˈɔkɪŋ', 'squawked': 'skwˈɔkt', 'vfr': 'ˌvi ˌɛf ˈɑɹ', 'ifr': 'ˌI ˌɛf ˈɑɹ',
    'cirrus': 'sˈɪɹəs', 'diamond': 'dˈImənd', 'garmin': 'ɡˈɑɹmɪn', 'avgas': 'ˈævɡˌæs', 'jet-a': 'ʤˈɛt ˈA',
    'gluons': 'ɡlˈuˌɑnz', 'electrons': 'ᵻlˈɛktɹˌɑnz', 'antiquarks': 'ˈæntikwˌɑɹks', 'antiquark': 'ˈæntikwˌɑɹk',
    'surrounded': 'səɹˈWndᵻd', 'carries': 'kˈɛɹiz', 'tighter': 'tˈIɾəɹ',
}
NATO = {'A': 'alpha', 'B': 'bravo', 'C': 'charlie', 'D': 'delta', 'E': 'echo', 'F': 'foxtrot', 'G': 'golf', 'H': 'hotel',
        'I': 'india', 'J': 'juliet', 'K': 'kilo', 'L': 'lima', 'M': 'mike', 'N': 'november', 'O': 'oscar', 'P': 'papa',
        'Q': 'quebec', 'R': 'romeo', 'S': 'sierra', 'T': 'tango', 'U': 'uniform', 'V': 'victor', 'W': 'whiskey',
        'X': 'x-ray', 'Y': 'yankee', 'Z': 'zulu'}
UNITS = {'NM': 'nautical miles', 'nm': 'nautical miles', 'kt': 'knots', 'kts': 'knots', 'KT': 'knots', 'ft': 'feet',
         'mph': 'miles per hour', 'fpm': 'feet per minute', 'sm': 'statute miles', 'SM': 'statute miles', 'inHg': 'inches of mercury',
         'hPa': 'hectopascals', 'mb': 'millibars', 'gal': 'gallons', 'lbs': 'pounds', 'lb': 'pounds', 'nm.': 'nautical miles'}
DIGIT_CTX = {'squawk', 'squawking', 'code', 'runway', 'heading', 'transponder', 'frequency', 'flight', 'level', 'radial', 'course', 'altimeter', 'november',
             'fl', 'wind', 'winds'}
# A 4-digit number after one of these (and not followed by a unit) is a year: "in 1903" -> nineteen oh three
YEAR_PREV = {'in', 'since', 'by', 'until', 'of', 'year', 'circa', 'during', 'before', 'after', 'from', 'around'}
UNIT_NEXT = {'feet', 'foot', 'ft', 'knots', 'kt', 'kts', 'miles', 'nm', 'sm', 'meters', 'metres', 'pounds', 'lbs', 'lb', 'gallons', 'gal',
             'hours', 'hrs', 'rpm', 'degrees', 'fpm', 'mph', 'people', 'aircraft', 'planes', 'airports', 'hp', 'horsepower'}
ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
RWY_SIDE = {'L': 'left', 'R': 'right', 'C': 'center'}
VERB_PREV = {'to', 'will', 'would', 'can', 'could', 'should', 'must', 'may', 'might', 'shall', 'please', 'you', 'we',
             'they', 'i', "don't", "doesn't", "didn't", "won't", "can't", 'never', 'always', 'then', 'also', 'just', "let's"}
NOUN_PREV = {'the', 'a', 'an', 'your', 'my', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those',
             'every', 'each', 'some', 'any', 'no', 'of', 'in', 'for', 'on', 'at', 'with', 'from', 'into', 'per',
             'one', 'first', 'second', 'next', 'another', 'gusty', 'strong', 'light', 'calm', 'surface'}
DET_NEXT = {'the', 'a', 'an', 'your', 'its', 'this', 'that', 'these', 'those', 'my', 'our', 'their', 'it', 'them', 'him', 'her'}


def cardinal(n):
    n = int(n)
    if n < 10: return ONES[n]
    if n < 20: return TEENS[n - 10]
    if n < 100: return TENS[n // 10] + ('' if n % 10 == 0 else '-' + ONES[n % 10])
    if n < 1000: return ONES[n // 100] + ' hundred' + ('' if n % 100 == 0 else ' ' + cardinal(n % 100))
    for div, name in ((10**9, 'billion'), (10**6, 'million'), (1000, 'thousand')):
        if n >= div:
            return cardinal(n // div) + ' ' + name + ('' if n % div == 0 else ' ' + cardinal(n % div))


def digits(s): return ' '.join(ONES[int(c)] for c in s if c.isdigit())


def year(n):
    n = int(n)
    hi, lo = divmod(n, 100)
    if 2000 <= n <= 2009: return cardinal(n)                      # two thousand five
    if lo == 0: return cardinal(hi) + ' hundred'                  # nineteen hundred
    return cardinal(hi) + ' ' + (('oh ' + ONES[lo]) if lo < 10 else cardinal(lo))


def say_number(tok, prev, nxt):
    """Turn a numeric token into words, the way a pilot would say it."""
    m = re.fullmatch(r'(\d+)([LRC]?)', tok)
    if m and prev == 'runway':
        return digits(m.group(1)) + (' ' + RWY_SIDE[m.group(2)] if m.group(2) else '')
    t = tok.replace(',', '')
    if re.fullmatch(r'\d+\.\d+', t):
        a, b = t.split('.')
        if 108 <= int(a) <= 137 or prev in DIGIT_CTX:      # radio frequency / altimeter
            return digits(a) + ' point ' + digits(b)
        return cardinal(a) + ' point ' + digits(b)
    if not t.isdigit(): return tok
    if prev in DIGIT_CTX or (len(t) == 4 and prev in {'squawk', 'code'}) or t.startswith('0'):
        return digits(t)
    if len(t) == 4 and 1100 <= int(t) <= 2099 and prev in YEAR_PREV and nxt.lower() not in UNIT_NEXT:
        return year(t)
    return cardinal(t)


def raw(word):
    for k in (word, word.lower()):
        if k in AV_WORDS: return AV_WORDS[k], 'aviation'
    for lex, name in ((GOLD, 'gold'), (SILVER, 'silver')):
        for k in (word, word.lower(), word.capitalize()):
            v = lex.get(k)
            if v is not None: return v, name
    return None, None


def plural(stem):
    if stem[-1] in 'ptkfθ': return stem + 's'
    if stem[-1] in 'szʃʒʧʤ': return stem + 'ᵻz'
    return stem + 'z'


def demote(ps):  # primary -> secondary
    return ps.replace(P, S2)


def letters(word):
    ps = ''.join(demote(GOLD[c]) for c in word.upper() if c.isalpha())
    i = ps.rfind(S2)
    return (ps[:i] + P + ps[i + 1:]) if i >= 0 else ps


NOUN_RARE = {'close', 'live', 'wound', 'bow', 'tear'}


def pick_pos(v, prev, nxt, word=''):
    if not isinstance(v, dict): return v, ''
    if 'VERB' not in v and 'NOUN' not in v: return v['DEFAULT'], ''
    want = None
    if prev in VERB_PREV or nxt.lower() in DET_NEXT: want = 'VERB'
    if prev in NOUN_PREV and word.lower() not in NOUN_RARE: want = 'NOUN'
    if want == 'VERB' and 'VERB' in v: return v['VERB'], 'heteronym:VERB'
    if want == 'NOUN' and 'NOUN' in v: return v['NOUN'], 'heteronym:NOUN'
    return v['DEFAULT'], 'heteronym:DEFAULT'


def word_ps(word, prev, nxt):
    """Return (phonemes, source) for one word token."""
    lw = word.lower()
    if lw in ('the', 'a', 'to') and nxt:
        np_ = (word_ps(nxt, word, '')[0] or nxt).replace(P, '').replace(S2, '')
        vow = np_[:1] in VOWELS
    else:
        vow = False
    if lw == 'the': return ('ði' if vow else 'ðə'), 'gold'
    if lw == 'a': return 'ɐ', 'gold'
    if lw == 'an': return 'ɐn', 'gold'
    if lw == 'to': return ('tʊ' if vow else 'tə'), 'gold'
    if lw == 'in': return 'ɪn', 'gold'
    if word.upper() == word and len(word) >= 2 and word.isalpha():          # acronym
        base, s = word, ''
        if base.endswith('S') and base[:-1] in AV_ACR: base, s = base[:-1], 's'
        if base in AV_ACR: return (plural(AV_ACR[base]) if s else AV_ACR[base]), 'aviation-acronym'
        if word in AV_WORDS: return AV_WORDS[word], 'aviation'
        return letters(word), 'acronym-letters'
    v, src = raw(word)
    if v is not None:
        ps, tag = pick_pos(v, prev, nxt, word)
        return ps, (tag or src)
    if lw.endswith("'s") and raw(lw[:-2])[0]:
        st, _ = raw(lw[:-2]); st, _ = pick_pos(st, prev, nxt); return plural(st), 'possessive'
    if lw.endswith('s') and len(lw) > 3:
        for stem in (lw[:-1], lw[:-2] if lw.endswith('es') else None):
            if stem and raw(stem)[0]:
                st, _ = pick_pos(raw(stem)[0], prev, nxt); return plural(st), 'plural'
    if lw.endswith('ing') and len(lw) > 5:
        for stem in (lw[:-3], lw[:-3] + 'e', lw[:-4]):
            if raw(stem)[0]:
                st, _ = pick_pos(raw(stem)[0], prev, nxt); return st + 'ɪŋ', 'stem-ing'
    if lw.endswith('ed') and len(lw) > 4:
        for stem in (lw[:-2], lw[:-1], lw[:-3]):
            if raw(stem)[0]:
                st, _ = pick_pos(raw(stem)[0], prev, nxt)
                end = 'ᵻd' if st[-1] in 'td' else ('t' if st[-1] in 'pkfθsʃʧ' else 'd')
                return st + end, 'stem-ed'
    if "'" in lw:
        a, b = lw.split("'", 1)
        if raw(a)[0]:
            st, _ = pick_pos(raw(a)[0], prev, nxt)
            return st + {'re': 'ɹ', 'll': 'l', 've': 'v', 'd': 'd', 't': 't', 'm': 'm'}.get(b, ''), 'contraction'
    for i in range(3, len(lw) - 2):                                         # compound: two known words
        a, b = raw(lw[:i])[0], raw(lw[i:])[0]
        if a and b and not isinstance(a, dict) and not isinstance(b, dict):
            return a + demote(b), 'compound'
    return None, 'UNKNOWN'


NUMLOG = []
OVR = re.compile(r'\[([^\]]+)\]\(/([^/]+)/\)')
TOK = re.compile(r"\[[^\]]+\]\(/[^/]+/\)|N\d{1,5}[A-Z]{0,2}\b|\d{4}Z\b|\d[\d,]*(?:\.\d+)?[LRC]?|[A-Za-z]+(?:[-'][A-Za-z]+)*|[.,!?;:—…]|\s+|%|°")


def caption_text(text): return OVR.sub(r'\1', text)


def expand(text):
    """Split text into (display, spoken_word_or_None, forced_ps_or_None) units, expanding numbers/units/tail numbers."""
    toks = [t for t in TOK.findall(text.replace('’', "'"))]
    out, cpos, offs = [], 0, []
    for t in toks:                                   # caption offsets (overrides shown as plain words)
        m = OVR.fullmatch(t); offs.append(cpos); cpos += len(m.group(1)) if m else len(t)
    for i, t in enumerate(toks):
        c = offs[i]
        if t.isspace(): out.append((t, None, None, c)); continue
        m = OVR.fullmatch(t)
        if m: out.append((m.group(1), m.group(1), m.group(2), c)); continue
        prev = next((toks[j].lower() for j in range(i - 1, -1, -1) if re.match(r'[\w]', toks[j])), '')
        nxt = next((toks[j] for j in range(i + 1, len(toks)) if re.match(r'[\w]', toks[j])), '')
        if re.fullmatch(r'N\d{1,5}[A-Z]{0,2}', t):
            spoken = 'november ' + digits(re.sub(r'\D', '', t)) + ''.join(' ' + NATO[ch] for ch in re.sub(r'^N\d+', '', t))
            out.append((t, spoken, None, c)); continue
        if re.fullmatch(r'\d{4}Z', t):                    # 1500Z -> one five zero zero zulu
            out.append((t, digits(t) + ' zulu', None, c)); continue
        if t == 'FL' and re.match(r'\d', nxt or ''):          # FL350 -> flight level three five zero
            out.append((t, 'flight level', None, c)); continue
        if re.match(r'\d', t):
            sp = say_number(t, prev, nxt)
            NUMLOG.append((t, sp))
            out.append((t, sp, None, c)); continue
        if t == '%': out.append((t, 'percent', None, c)); continue
        if t == '°': out.append((t, 'degrees', None, c)); continue
        if t in UNITS and re.match(r'\d', prev or 'x'):
            out.append((t, UNITS[t], None, c)); continue
        if re.match(r'[A-Za-z]', t): out.append((t, t, None, c)); continue
        out.append((t, None, None, c))
    return out


def phonemize_sentence(text):
    units = expand(text)
    # flatten spoken words for context
    flat = []
    for disp, spoken, forced, c in units:
        if spoken is None: flat.append(('P', disp, None, None, c)); continue
        if forced: flat.append(('W', spoken, forced, disp, c)); continue
        for k, w in enumerate(spoken.replace('-', ' - ').split()):
            if w == '-': continue
            flat.append(('W', w, None, disp if k == 0 else '', c))
    ps, words = '', []
    for i, f in enumerate(flat):
        if f[0] == 'P':
            s = f[1]
            if s.isspace(): s = ' '
            ps += s; continue
        prev = next((flat[j][1].lower() for j in range(i - 1, -1, -1) if flat[j][0] == 'W'), '')
        nxt = ''
        for j in range(i + 1, len(flat)):
            if flat[j][0] == 'W': nxt = flat[j][1]; break
            if not flat[j][1].isspace(): break        # punctuation ends the phrase
        nxt = nxt if (nxt.isupper() and len(nxt) > 1) else nxt.lower()
        if f[2]: wp, src = f[2], 'override'
        elif '-' in f[1] and not raw(f[1])[0]:
            parts = [word_ps(p, prev, nxt) for p in f[1].split('-')]
            wp = ' '.join(p[0] or '?' for p in parts); src = 'hyphen' if all(p[0] for p in parts) else 'UNKNOWN'
        else:
            wp, src = word_ps(f[1], prev, nxt)
        if wp is None: wp = '?'
        if ps and not ps.endswith(' ') and ps[-1] not in '“(': ps += ' '
        a = len(ps); ps += wp
        words.append({'text': f[3] if f[3] is not None else f[1], 'word': f[1], 'ps': wp, 'src': src, 'a': a, 'b': len(ps), 'c': f[4]})
    ps = re.sub(r' +([.,!?;:])', r'\1', ps)
    ps = re.sub(r'\s+', ' ', ps).strip()
    # recompute spans after whitespace cleanup
    pos = 0
    for w in words:
        k = ps.find(w['ps'], pos)
        if k >= 0: w['a'], w['b'] = k, k + len(w['ps']); pos = w['b']
    return ps, words


def audit(lines, show_gold=False):
    """Print every word whose pronunciation is a guess or a choice, so it can be checked before recording."""
    seen, unknown = {}, []
    for line in lines:
        for sent in split_sentences(line):
            _, words = phonemize_sentence(sent)
            for w in words:
                key = (w['word'].lower(), w['ps'])
                if w['src'] == 'UNKNOWN': unknown.append(w['word'])
                if w['src'] in ('gold', 'silver', 'plural', 'possessive', 'contraction') and not show_gold: continue
                seen.setdefault(key, (w['word'], w['ps'], w['src'], sent))
    for (_, _), (word, ps, src, sent) in sorted(seen.items(), key=lambda x: x[1][2]):
        print(f'{src:18s} {word:16s} {ps:22s} | {sent[:60]}')
    for t, sp in dict(NUMLOG).items(): print(f'{"number":18s} {t:16s} -> {sp}')
    if unknown:
        print('\nUNKNOWN WORDS (add to AV_WORDS or use [word](/phonemes/) inline):', sorted(set(unknown)))
    return sorted(set(unknown))


def load_scenes(path):
    """script.json is either a list of scenes or {"allow_repeat": [...], "scenes": [...]}; return the scene list."""
    data = json.load(open(path))
    return data['scenes'] if isinstance(data, dict) else data


def split_sentences(line):
    return [p.strip() for p in re.split(r'(?<=[.!?])\s+', line.strip()) if p.strip()]


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1].endswith('.json'):
        S = load_scenes(sys.argv[1])
        audit([l for s in S for l in s['lines']])
    else:
        for s in split_sentences(' '.join(sys.argv[1:])):
            print(phonemize_sentence(s)[0])
```

## File: tts_av.py
House narrator. Do not change VOICE.
```python
"""House narrator for aviation explainer videos.
usage: python3 tts_av.py script.json OUTDIR [--speed 0.95] [--no-clarity]
Voice is fixed: am_michael*0.7 + am_fenrir*0.3 (Kokoro v1.0, timing-export model).
Writes OUTDIR/narration.wav (48 kHz mono) and OUTDIR/timeline.json with sentence + per-word caption timings.
Each script line is voiced in one pass (natural flow across its sentences); exact timings come from the model."""
import argparse, json, os, re, sys, wave
import numpy as np
import onnxruntime as rt
from scipy.signal import resample_poly, butter, sosfilt, lfilter
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from g2p_av import phonemize_sentence, split_sentences, caption_text, load_scenes

VOICE = 'am_michael*0.7+am_fenrir*0.3'          # house voice - do not change
SR, OUT_SR = 24000, 48000
MODEL = os.environ.get('KOKORO_MODEL', os.path.join(HERE, 'models/kokoro-v1.0-timed.onnx'))
VOICES = os.environ.get('KOKORO_VOICES', os.path.join(HERE, 'models/voices-v1.0.bin'))
VOCAB = os.environ.get('KOKORO_VOCAB', os.path.join(HERE, 'kokoro-onnx/src/kokoro_onnx/config.json'))
MAX_PS = 480                                      # phonemes per model pass (Kokoro caps at ~510 tokens)


def split_long(s):
    """Split a sentence whose phonemes exceed MAX_PS at clause breaks (then word gaps) into voiceable pieces."""
    if len(phonemize_sentence(s)[0]) <= MAX_PS: return [s]
    for pat in (r'(?<=[,;:—])\s+', r'\s+'):
        parts, out, cur = re.split(pat, s), [], ''
        for p in parts:
            tr = (cur + ' ' + p).strip()
            if cur and len(phonemize_sentence(tr)[0]) > MAX_PS: out.append(cur); cur = p
            else: cur = tr
        if cur: out.append(cur)
        if all(len(phonemize_sentence(o)[0]) <= MAX_PS for o in out): return out
    return out


def biquad_peak(f0, g, q, fs):
    A = 10 ** (g / 40); w = 2 * np.pi * f0 / fs; al = np.sin(w) / (2 * q); c = np.cos(w)
    b = np.array([1 + al * A, -2 * c, 1 - al * A]); a = np.array([1 + al / A, -2 * c, 1 - al / A]); return b / a[0], a / a[0]


def biquad_hishelf(f0, g, fs):
    A = 10 ** (g / 40); w = 2 * np.pi * f0 / fs; c, s = np.cos(w), np.sin(w); al = s / 2 * np.sqrt(2); r = 2 * np.sqrt(A) * al
    b = np.array([A * ((A + 1) + (A - 1) * c + r), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - r)])
    a = np.array([(A + 1) - (A - 1) * c + r, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - r]); return b / a[0], a / a[0]


def follow(x, tau, fs):
    k = np.exp(-1 / (tau * fs)); return lfilter([1 - k], [1, -k], x)


def clarity(x, fs):
    """Broadcast-style voice polish: rumble cut, de-mud, presence, air, de-ess, gentle leveling."""
    x = sosfilt(butter(2, 75, 'hp', fs=fs, output='sos'), x)
    for b, a in (biquad_peak(260, -2.5, 1.0, fs), biquad_peak(3200, 3.0, 0.9, fs), biquad_hishelf(8000, 2.0, fs)):
        x = lfilter(b, a, x)
    hi = sosfilt(butter(2, 5500, 'hp', fs=fs, output='sos'), x)            # de-esser
    eh, ea = follow(np.abs(hi), .004, fs), follow(np.abs(x), .012, fs)
    g = follow(np.clip(0.45 * ea / (eh + 1e-9), 0.45, 1.0), .006, fs)
    x = x - hi + hi * g
    x = x / (np.abs(x).max() + 1e-9) * 0.9                                  # compressor 2.5:1 above -20 dBFS
    env = np.sqrt(follow(x * x, .02, fs) + 1e-12); lvl = 20 * np.log10(env)
    gdb = -np.maximum(0, lvl + 20) * (1 - 1 / 2.5)
    x = x * 10 ** (follow(gdb, .04, fs) / 20)
    return (x / (np.abs(x).max() + 1e-9) * 0.89).astype(np.float32)


class Narrator:
    def __init__(self, speed=0.95):
        for f, env in ((MODEL, 'KOKORO_MODEL'), (VOICES, 'KOKORO_VOICES'), (VOCAB, 'KOKORO_VOCAB')):
            if not os.path.isfile(f): sys.exit(f'missing {f} - run setup.sh in this folder, or set {env}')
        self.vocab = json.load(open(VOCAB))['vocab']
        so = rt.SessionOptions(); so.intra_op_num_threads = os.cpu_count() or 2
        self.sess = rt.InferenceSession(MODEL, so, providers=['CPUExecutionProvider'])
        names = [i.name for i in self.sess.get_inputs()]
        self.tok = 'input_ids' if 'input_ids' in names else 'tokens'
        outs = [o.name for o in self.sess.get_outputs()]
        if len(outs) < 2: sys.exit('Model has no duration output - download kokoro-v1.0.onnx from release model-files-v1.1')
        vs = np.load(VOICES)
        self.style = sum(float(w) * vs[n] for n, w in (p.split('*') for p in VOICE.split('+')))
        self.speed = speed

    def run(self, ps):
        idx = [i for i, ch in enumerate(ps) if ch in self.vocab]
        toks = [self.vocab[ps[i]] for i in idx]
        st = self.style[min(len(toks), len(self.style)) - 1]
        out = self.sess.run(None, {self.tok: np.array([[0, *toks, 0]], np.int64), 'style': st.astype(np.float32), 'speed': np.array([self.speed], np.float32)})
        audio = np.asarray(out[0]).ravel().astype(np.float32); dur = np.asarray(out[1]).ravel().astype(np.float64)
        fr = np.concatenate([[0], np.cumsum(dur)]); edges = fr * (len(audio) / fr[-1])
        t0 = np.full(len(ps), np.nan); t1 = np.full(len(ps), np.nan)
        for k, i in enumerate(idx): t0[i], t1[i] = edges[k + 1] / SR, edges[k + 2] / SR
        return audio, t0, t1

    def line(self, text):
        """Voice one script line. Returns audio and sentence dicts with caption tokens timed per word."""
        sents = [s for s in split_sentences(text)]
        chunks, cur = [], []
        for gi, sent in enumerate(sents):                      # keep each model pass under MAX_PS phonemes
            for s in split_long(sent):                         # an overlong sentence is voiced in pieces, then rejoined
                ps, words = phonemize_sentence(s)
                if cur and sum(len(c[1]) for c in cur) + len(ps) > MAX_PS: chunks.append(cur); cur = []
                cur.append((s, ps, words, gi))
        if cur: chunks.append(cur)
        audio, out, off = [], [], 0.0
        for ch in chunks:
            full, spans = '', []
            for s, ps, words, gi in ch:
                if full: full += ' '
                spans.append((s, len(full), words, gi)); full += ps
            a, t0, t1 = self.run(full)
            env = np.convolve(np.abs(a), np.ones(240) / 240, 'same'); nz = np.where(env > 0.006)[0]
            lo = max(0, nz[0] - 480) if len(nz) else 0; hi = min(len(a), nz[-1] + 2400) if len(nz) else len(a)
            a = a[lo:hi]; sh = lo / SR
            for s, base, words, gi in spans:
                cap = caption_text(s); toks = []
                for m in re.finditer(r'\S+', cap):
                    ws = [w for w in words if m.start() <= w['c'] < m.end()]
                    tt0 = [t0[base + w['a']:base + w['b']] for w in ws]; tt1 = [t1[base + w['a']:base + w['b']] for w in ws]
                    v0 = np.concatenate(tt0) if tt0 else np.array([]); v1 = np.concatenate(tt1) if tt1 else np.array([])
                    v0, v1 = v0[~np.isnan(v0)], v1[~np.isnan(v1)]
                    if len(v0): toks.append({'text': m.group(0), 'start': off + v0.min() - sh, 'end': off + v1.max() - sh})
                    elif toks: toks[-1]['text'] += ' ' + m.group(0)
                if not toks: continue
                if out and out[-1]['g'] == gi:                 # piece of the same sentence: merge back into one
                    o = out[-1]; o['text'] += ' ' + cap; o['end'] = toks[-1]['end']; o['tokens'] += toks
                else: out.append({'text': cap, 'start': toks[0]['start'], 'end': toks[-1]['end'], 'tokens': toks, 'g': gi})
            audio.append(a); off += len(a) / SR
            audio.append(np.zeros(int(.22 * SR), np.float32)); off += .22
        for o in out: o.pop('g')
        return np.concatenate(audio[:-1]) if audio else np.zeros(1, np.float32), out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('script'); ap.add_argument('outdir')
    ap.add_argument('--speed', type=float, default=0.95); ap.add_argument('--no-clarity', action='store_true')
    ap.add_argument('--line-gap', type=float, default=0.55)
    A = ap.parse_args()
    script = load_scenes(A.script); N = Narrator(A.speed)
    pieces, t, scenes = [], 0.0, []
    for si, sc in enumerate(script):
        lead = sc.get('lead', 1.2 if si == 0 else 1.6)
        pieces.append(np.zeros(int(lead * SR), np.float32)); t += lead
        S = {'title': sc['title'], 'start': t - lead, 'lines': []}
        for li, line in enumerate(sc['lines']):
            a, sents = N.line(line)
            for s in sents:
                s['start'] += t; s['end'] += t
                for k in s['tokens']: k['start'] += t; k['end'] += t
            S['lines'].append({'start': t, 'end': t + len(a) / SR, 'sents': sents})
            pieces.append(a); t += len(a) / SR
            pieces.append(np.zeros(int(A.line_gap * SR), np.float32)); t += A.line_gap
            print(f'{si}.{li} {len(a) / SR:5.1f}s  {line[:60]}', flush=True)
        S['end'] = t; scenes.append(S)
    pieces.append(np.zeros(int(3.0 * SR), np.float32)); t += 3.0; scenes[-1]['end'] = t
    x = resample_poly(np.concatenate(pieces), OUT_SR // SR, 1).astype(np.float32)
    x = x / (np.abs(x).max() + 1e-9) * 0.89 if A.no_clarity else clarity(x, OUT_SR)
    os.makedirs(A.outdir, exist_ok=True)
    with wave.open(os.path.join(A.outdir, 'narration.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(OUT_SR); w.writeframes((x * 32767).astype(np.int16).tobytes())
    json.dump({'duration': t, 'sr': OUT_SR, 'scenes': scenes}, open(os.path.join(A.outdir, 'timeline.json'), 'w'), indent=1)
    print('TOTAL', round(t, 1), 's')


if __name__ == '__main__':
    main()
```

## File: check_script.py

```python
"""Script QA for explainer narration: repeated content, overlong lines, pacing.
usage: python3 check_script.py script.json
script.json is a list of scenes, or {"allow_repeat": [...], "scenes": [...]}; any scene may also carry its own
"allow_repeat" list. Use it for names that must recur (terms), not explanations. tts_av.py accepts both shapes."""
import json, re, sys, itertools
STOP = set('''a an the and or but if then so of to in on at by for with from into onto over under as is are was were be been being it its
this that these those there here you your we our they their he she his her i me my them do does did not no yes can could will would should
must may might just also very really all any each every some more most one two three four five first now when where which who what how why
because than too about up down out off again only even still like get gets got let lets make makes made has have had way go going'''.split())


def words(s): return re.findall(r"[a-z0-9']+", s.lower().replace('’', "'"))


def content(s): return [w for w in words(s) if w not in STOP and len(w) > 2]


def main(path):
    data = json.load(open(path))
    scenes = data['scenes'] if isinstance(data, dict) else data
    allow = set(map(str.lower, (data.get('allow_repeat', []) if isinstance(data, dict) else [])))
    for sc in scenes: allow |= set(map(str.lower, sc.get('allow_repeat', [])))
    L = [(si, li, l) for si, sc in enumerate(scenes) for li, l in enumerate(sc['lines'])]
    issues = 0
    grams = {}
    for si, li, l in L:
        cw = content(l)
        for n in (2, 3, 4):
            for i in range(len(cw) - n + 1):
                g = ' '.join(cw[i:i + n])
                if any(g == a or g in a for a in allow): continue
                grams.setdefault(g, set()).add((si, li))
    print('REPEATED PHRASES (narrated in more than one line):')
    shown = set()
    for g, where in sorted(grams.items(), key=lambda x: (-len(x[0].split()), x[0])):
        if len(where) < 2: continue
        key = frozenset(where)
        if any(key <= k for k in shown): continue
        shown.add(key); issues += 1
        print(f'  "{g}"  ->', ', '.join(f'ch{si + 1}.L{li + 1}' for si, li in sorted(where)))
    print('\nSIMILAR LINES (same idea said twice?):')
    for (a, b) in itertools.combinations(L, 2):
        A, B = set(content(a[2])), set(content(b[2]))
        if len(A) < 3 or len(B) < 3: continue
        j = len(A & B) / len(A | B)
        if j >= 0.34:
            issues += 1
            print(f'  {j:.2f}  ch{a[0] + 1}.L{a[1] + 1}: {a[2][:55]}\n        ch{b[0] + 1}.L{b[1] + 1}: {b[2][:55]}')
    print('\nPACING:')
    tot = 0
    for si, li, l in L:
        n = len(words(l)); tot += n
        for s in re.split(r'(?<=[.!?])\s+', l):
            if len(words(s)) > 20: issues += 1; print(f'  long sentence ({len(words(s))} words) ch{si + 1}.L{li + 1}: {s[:60]}')
        if n > 30: issues += 1; print(f'  long line ({n} words) ch{si + 1}.L{li + 1} - split it so visuals can change')
    print(f'  {tot} words  ~{tot / 2.45 / 60:.1f} min of narration, {len(scenes)} chapters, {len(L)} lines')
    print(f'\n{issues} item(s) to review')


if __name__ == '__main__':
    main(sys.argv[1])
```

## File: engine.js

```javascript
/* Aviation explainer engine — 1080x1920 canvas, frame-exact, narration-timed.
   A film page defines window.FILM = { scenes:[fn(t)...], setup(){...} } and loads this file. */
const W=1080,H=1920,CX=540,TAU=Math.PI*2;
const cv=document.getElementById('c'),ctx=cv.getContext('2d');
const clamp=(x,a=0,b=1)=>x<a?a:x>b?b:x, lerp=(a,b,f)=>a+(b-a)*f;
const sm=x=>{x=clamp(x);return x*x*(3-2*x)};
const eio=x=>{x=clamp(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2};
const eout=x=>{x=clamp(x);return 1-Math.pow(1-x,3)};
const eob=x=>{x=clamp(x);const c1=1.7,c3=c1+1;return 1+c3*Math.pow(x-1,3)+c1*Math.pow(x-1,2)};
const ap=(s,d=.5)=>s<=0?0:sm(s/d);            // 0→1 ramp starting when s crosses 0
const pop=(s,d=.5)=>s<=0?0:eob(s/d);           // overshoot pop-in
const win=(t,a,b,fi=.4,fo=.4)=>ap(t-a,fi)*(1-ap(t-b,fo));
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rgba=(c,a=1)=>`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;
const mix=(a,b,f)=>[lerp(a[0],b[0],f),lerp(a[1],b[1],f),lerp(a[2],b[2],f)];
const shade=(c,f)=>f<0?mix(c,[0,0,0],-f):mix(c,[255,255,255],f);
let GA=1;const A=a=>{ctx.globalAlpha=clamp(a*GA)};  // ALWAYS set alpha through A() so scene crossfades work

const COL={white:[246,246,255],muted:[162,168,216],gold:[255,204,90],amber:[255,184,84],blue:[96,166,255],ink:[12,14,42],
  green:[70,255,130],red:[255,62,76],lamp:[255,248,232],accent:[124,112,244],sky:[96,166,255]};

/* ---------- timeline (from tts_av.py) ---------- */
let TL,CAPS=[],EV=[];
const sc=i=>TL.scenes[i], ln=(s,l)=>TL.scenes[s].lines[l];
const st=(s,l,k=0)=>{const L=ln(s,l);return L.sents[Math.min(k,L.sents.length-1)].start};   // sentence k start
const se=(s,l,k=0)=>{const L=ln(s,l);return L.sents[Math.min(k,L.sents.length-1)].end};
const sd=(s,l,k=0)=>se(s,l,k)-st(s,l,k);
const ls=(s,l)=>ln(s,l).start, le=(s,l)=>ln(s,l).end;
/* at(s,l,'word',n=0): start time of the n-th caption token in line l containing 'word' — sync visuals to a spoken word */
function at(s,l,word,n=0){const w=word.toLowerCase();let k=0;for(const S of ln(s,l).sents)for(const tk of S.tokens){if(tk.text.toLowerCase().replace(/[^a-z0-9.%']/g,'').includes(w)){if(k===n)return tk.start;k++}}return st(s,l)}
const trS=k=>ls(k,0)-1.0;                                  // chapter crossfade start
function lineIdx(s,t){let i=0;const n=sc(s).lines.length;for(let k=0;k<n;k++)if(t>=ls(s,k)-.3)i=k;return i}
const nextStart=(s,l)=>l+1<sc(s).lines.length?ls(s,l+1):sc(s).end+30;
const lineA=(s,l,t)=>(l===0?1:ap(t-(ls(s,l)-.3),.3))*(1-ap(t-(nextStart(s,l)-.3),.3));   // visibility of a per-line element
const ev=(t,type,x={})=>EV.push({t,type,...x});          // sound event

/* ---------- primitives ---------- */
const spriteCache=new Map();
function glowSprite(c){const k=c.map(v=>v|0).join(',');if(spriteCache.has(k))return spriteCache.get(k);
  const s=document.createElement('canvas');s.width=s.height=256;const g=s.getContext('2d');const gr=g.createRadialGradient(128,128,0,128,128,128);
  gr.addColorStop(0,rgba(c,1));gr.addColorStop(.16,rgba(c,.55));gr.addColorStop(.42,rgba(c,.16));gr.addColorStop(.7,rgba(c,.04));gr.addColorStop(1,rgba(c,0));
  g.fillStyle=gr;g.fillRect(0,0,256,256);spriteCache.set(k,s);return s}
function glow(x,y,r,c,a){if(a<=0.002||r<=0)return;A(a);const op=ctx.globalCompositeOperation;ctx.globalCompositeOperation='lighter';ctx.drawImage(glowSprite(c),x-r,y-r,r*2,r*2);ctx.globalCompositeOperation=op}
function circle(x,y,r){ctx.beginPath();ctx.arc(x,y,Math.max(0,r),0,TAU)}
function font(size,w=700,f='Figtree'){return `${w} ${size}px ${f}, 'Inter', sans-serif`}
function text(s,x,y,o={}){const a=o.a??1;if(a<=0.002)return;A(a);ctx.save();
  if(o.rot){ctx.translate(x,y);ctx.rotate(o.rot);x=0;y=0}
  ctx.font=font(o.size||40,o.w||700,o.font||'Figtree');ctx.textAlign=o.align||'center';ctx.textBaseline=o.base||'middle';
  if(o.ls)ctx.letterSpacing=o.ls+'px';
  if(o.stroke){ctx.lineJoin='round';ctx.lineWidth=o.stroke;ctx.strokeStyle=o.strokeCol||'rgba(6,6,22,.9)';ctx.strokeText(s,x,y)}
  if(o.glow){ctx.shadowColor=rgba(o.glowCol||o.color||COL.white,.9);ctx.shadowBlur=o.glow}
  ctx.fillStyle=Array.isArray(o.color)?rgba(o.color):(o.color||'#fff');ctx.fillText(s,x,y);ctx.restore()}
function textW(s,size,w=700,f='Figtree',lsp=0){ctx.save();ctx.font=font(size,w,f);ctx.letterSpacing=lsp+'px';const m=ctx.measureText(s).width;ctx.restore();return m}
function fit(s,maxW,size,w=800,f='Outfit',lsp=0){const m=textW(s,size,w,f,lsp);return m>maxW?size*maxW/m:size}
function wrap(s,maxW,size,w=700,f='Figtree'){const out=[];let cur='';for(const wd of s.split(' ')){const tr=cur?cur+' '+wd:wd;if(cur&&textW(tr,size,w,f)>maxW){out.push(cur);cur=wd}else cur=tr}if(cur)out.push(cur);return out}
function pill(s,x,y,o={}){const a=o.a??1;if(a<=0.002)return;const size=o.size||34,w=textW(s,size,o.w||700,o.font||'Figtree',o.ls||0),ph=size*.62,h=size*1.75;
  const k=o.scale??1;ctx.save();ctx.translate(x,y);ctx.scale(k,k);A(a);ctx.beginPath();ctx.roundRect(-w/2-ph,-h/2,w+ph*2,h,h/2);ctx.fillStyle=o.bg||'rgba(13,12,40,.9)';ctx.fill();
  if(o.border){ctx.lineWidth=3;ctx.strokeStyle=rgba(o.border,.95);ctx.stroke()}ctx.restore();ctx.save();ctx.translate(x,y);ctx.scale(k,k);text(s,0,2,{...o,a,glow:0,stroke:0});ctx.restore()}
function callout(s,px,py,lx,ly,a,o={}){if(a<=0.002)return;const c=o.border||COL.white;const f=eout(clamp(a*1.6));A(a);ctx.strokeStyle=rgba(c,.9);ctx.lineWidth=3.5;ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(lerp(px,lx,f),lerp(py,ly,f));ctx.stroke();A(a);circle(px,py,8);ctx.fillStyle=rgba(c);ctx.fill();
  const b=clamp((a-.35)/.65);pill(s,lx,ly,{...o,a:b,scale:lerp(.7,1,eob(b))})}
function arrow(x1,y1,x2,y2,c,lw,a){if(a<=0.002)return;A(a);ctx.strokeStyle=rgba(c);ctx.fillStyle=rgba(c);ctx.lineWidth=lw;ctx.lineCap='round';
  const an=Math.atan2(y2-y1,x2-x1),h=lw*2.4;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2-Math.cos(an)*h,y2-Math.sin(an)*h);ctx.stroke();
  ctx.beginPath();ctx.moveTo(x2+Math.cos(an)*lw*.6,y2+Math.sin(an)*lw*.6);ctx.lineTo(x2-Math.cos(an-.6)*h*1.5,y2-Math.sin(an-.6)*h*1.5);ctx.lineTo(x2-Math.cos(an+.6)*h*1.5,y2-Math.sin(an+.6)*h*1.5);ctx.closePath();ctx.fill()}
function reticle(x,y,r,t,a,c){if(a<=0.002)return;ctx.save();ctx.translate(x,y);ctx.rotate(t*.6);A(a);ctx.strokeStyle=rgba(c||COL.white,.9);ctx.lineWidth=4;ctx.beginPath();
  for(const[sx,sy] of[[-1,-1],[1,-1],[-1,1],[1,1]]){ctx.moveTo(sx*r,sy*(r-22));ctx.lineTo(sx*r,sy*r);ctx.lineTo(sx*(r-22),sy*r)}ctx.stroke();ctx.restore()}
function dashed(pts,c,a,lw=4){if(a<=0.002)return;A(a);ctx.setLineDash([14,12]);ctx.strokeStyle=rgba(c,.9);ctx.lineWidth=lw;ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.stroke();ctx.setLineDash([])}

/* ---------- lights ---------- */
/* blink(pattern,tl,col): pattern 'steady' | 'flash' | 'alt' (alternates col & col2) -> {col,i}; tl<0 = off */
function blink(pattern,tl,col,col2=COL.green,rate=1.35){if(tl<0)return{col,i:0};const on=sm(tl/.12);
  if(pattern==='alt'){const ph=(tl*1.2)%1,half=ph<.5,k=half?ph*2:(ph-.5)*2;return{col:half?col:col2,i:on*sm(k/.07)*(1-sm((k-.93)/.07))}}
  if(pattern==='steady')return{col,i:on};const ph=(tl*rate)%1;return{col,i:on*sm(ph/.05)*(1-sm((ph-.5)/.05))}}
function lamp(x,y,r,S,a=1,base){if(a<=0.002)return;base=base||S.col;A(a);circle(x,y,r*1.2);ctx.fillStyle='rgb(18,20,44)';ctx.fill();ctx.lineWidth=Math.max(2,r*.07);ctx.strokeStyle='rgba(150,160,225,.55)';ctx.stroke();
  circle(x,y,r);ctx.fillStyle=rgba(mix(base,[18,20,44],.74));ctx.fill();
  if(S.i>0.01){A(a*S.i);const g=ctx.createRadialGradient(x-r*.3,y-r*.3,r*.05,x,y,r);g.addColorStop(0,rgba(shade(S.col,.65)));g.addColorStop(1,rgba(S.col));ctx.fillStyle=g;circle(x,y,r);ctx.fill();glow(x,y,r*3.2,S.col,.8*S.i*a)}
  A(a*.55);ctx.beginPath();ctx.ellipse(x-r*.32,y-r*.38,r*.28,r*.15,-.6,0,TAU);ctx.fillStyle='rgba(255,255,255,.6)';ctx.fill()}
function beam(x0,y0,x1,y1,col,i,a=1,o={}){const k=i*a;if(k<=0.01)return;const dx=x1-x0,dy=y1-y0,L=Math.hypot(dx,dy);if(L<2)return;const nx=-dy/L,ny=dx/L,w0=o.w0??9,w1=o.w1??Math.max(44,L*.075);
  ctx.save();ctx.globalCompositeOperation='lighter';A(k);let g=ctx.createLinearGradient(x0,y0,x1,y1);g.addColorStop(0,rgba(col,.62));g.addColorStop(1,rgba(col,.1));ctx.fillStyle=g;
  ctx.beginPath();ctx.moveTo(x0+nx*w0,y0+ny*w0);ctx.lineTo(x1+nx*w1,y1+ny*w1);ctx.lineTo(x1-nx*w1,y1-ny*w1);ctx.lineTo(x0-nx*w0,y0-ny*w0);ctx.closePath();ctx.fill();
  g=ctx.createLinearGradient(x0,y0,x1,y1);g.addColorStop(0,rgba(shade(col,.65),.85));g.addColorStop(1,rgba(col,.06));ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(x0+nx*w0*.35,y0+ny*w0*.35);ctx.lineTo(x1+nx*w1*.28,y1+ny*w1*.28);ctx.lineTo(x1-nx*w1*.28,y1-ny*w1*.28);ctx.lineTo(x0-nx*w0*.35,y0-ny*w0*.35);ctx.closePath();ctx.fill();
  ctx.restore();glow(x0,y0,o.src??110,col,k);if((o.tgt??1)>0)glow(x1,y1,o.tgt??190,col,.75*k)}

/* ---------- world ---------- */
const STARS=Array.from({length:180},(_,i)=>{const r=rng(i*13+5);return{x:r()*W,y:r()*1300,s:1+r()*2.2,ph:r()*TAU,sp:.5+r()*2}});
const CITY=Array.from({length:60},(_,i)=>{const r=rng(i*29+3);return{x:r()*W,dy:r()*26,c:r()<.7?[255,200,130]:[200,220,255]}});
/* sky(t,day 0..1,horizonY) paints the whole frame (sky + ground). day=0 night with stars, 1 = clear day */
function sky(t,day=0,hor=1330){const top=mix([6,8,28],[58,138,228],day),mid=mix([20,20,62],[132,190,248],day),bot=mix([44,32,92],[206,228,255],day);
  A(1);let g=ctx.createLinearGradient(0,0,0,hor);g.addColorStop(0,rgba(top));g.addColorStop(.65,rgba(mid));g.addColorStop(1,rgba(bot));ctx.fillStyle=g;ctx.fillRect(-W,-H,W*3,hor+H);
  if(day<1){ctx.fillStyle='#fff';for(const s of STARS){if(s.y>hor-60)continue;A((1-day)*(.3+.35*Math.sin(t*s.sp+s.ph)));ctx.fillRect(s.x,s.y,s.s,s.s)}}
  A(1);g=ctx.createLinearGradient(0,hor,0,H);g.addColorStop(0,rgba(mix([20,22,44],[78,110,86],day)));g.addColorStop(1,rgba(mix([6,6,16],[40,60,46],day)));ctx.fillStyle=g;ctx.fillRect(-W,hor,W*3,H*2);
  if(day<1)for(const c of CITY)glow(c.x,hor+4+c.dy,7,c.c,(1-day)*.6);glow(W/2,hor,720,[120,90,210],.16*(1-day))}
/* gridBG: navy chart-paper background for diagrams, cards and recaps */
function gridBG(t){A(1);const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgb(9,11,38)');g.addColorStop(1,'rgb(17,13,50)');ctx.fillStyle=g;ctx.fillRect(-W,-H,W*3,H*3);
  A(.07);ctx.strokeStyle='rgb(150,170,255)';ctx.lineWidth=1.5;ctx.beginPath();for(let x=0;x<=W;x+=60){ctx.moveTo(x,0);ctx.lineTo(x,H)}for(let y=0;y<=H;y+=60){ctx.moveTo(0,y);ctx.lineTo(W,y)}ctx.stroke();glow(540,820,720,[90,80,230],.16)}
const CLOUDS=Array.from({length:7},(_,i)=>{const r=rng(i*41+9);return{dx:(r()-.5)*1.6,dy:(r()-.5)*.5,r:.35+r()*.35}});
function cloud(x,y,s,a=1,col=[236,240,255],dark=0){if(a<=0.002)return;const c=mix(col,[90,96,130],dark);A(a);ctx.fillStyle=rgba(c);for(const b of CLOUDS){circle(x+b.dx*120*s,y+b.dy*120*s,b.r*120*s);ctx.fill()}
  ctx.fillStyle=rgba(shade(c,-.12));ctx.fillRect(x-100*s,y+10*s,200*s,30*s)}
function runwaySide(t,o={}){const y=o.y??1330,x0=o.x0??330,x1=o.x1??1080,red=o.red||0;A(1);ctx.fillStyle='rgb(36,38,56)';ctx.beginPath();ctx.moveTo(x0+12,y-8);ctx.lineTo(x1+40,y-8);ctx.lineTo(x1+60,y+16);ctx.lineTo(x0-8,y+16);ctx.closePath();ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.45)';for(let x=x0+70;x<x1-20;x+=74)ctx.fillRect(x,y+3,40,3);
  for(let x=x0+14;x<=x1+30;x+=46){const c=red>0?mix([255,236,196],COL.red,clamp(red)):[255,236,196];glow(x,y-9,14+red*12,c,.85*(o.lights??1));glow(x+6,y+17,18+red*12,c,.9*(o.lights??1))}
  for(let j=0;j<5;j++)glow(x0-4,y-6+j*5.5,16,COL.red,.75*(o.lights??1))}
/* tower(x,baseY,scale,t) -> {gx,gy} cab centre (light-gun / radio source) */
function tower(x,base,s,t,o={}){const a=o.a??1;const shH=380*s,shW=74*s,cabY=base-shH,gH=80*s,topW=196*s,botW=150*s;
  if(a>0.002){A(a);ctx.fillStyle='rgb(38,42,82)';ctx.fillRect(x-130*s,base-70*s,260*s,70*s);ctx.fillStyle='rgba(255,206,140,.75)';for(let i=0;i<5;i++)ctx.fillRect(x-112*s+i*48*s,base-48*s,26*s,14*s);
  let g=ctx.createLinearGradient(x-shW/2,0,x+shW/2,0);g.addColorStop(0,'rgb(100,108,164)');g.addColorStop(.5,'rgb(72,80,134)');g.addColorStop(1,'rgb(44,50,96)');ctx.fillStyle=g;ctx.fillRect(x-shW/2,cabY,shW,shH);
  ctx.fillStyle='rgba(255,206,140,.6)';for(let i=0;i<6;i++)ctx.fillRect(x-6*s,cabY+40*s+i*52*s,12*s,18*s);ctx.fillStyle='rgb(54,60,110)';ctx.fillRect(x-botW/2-8*s,cabY-6*s,botW+16*s,18*s);
  ctx.beginPath();ctx.moveTo(x-botW/2,cabY);ctx.lineTo(x+botW/2,cabY);ctx.lineTo(x+topW/2,cabY-gH);ctx.lineTo(x-topW/2,cabY-gH);ctx.closePath();g=ctx.createLinearGradient(0,cabY-gH,0,cabY);g.addColorStop(0,'rgb(255,216,156)');g.addColorStop(1,'rgb(255,168,98)');ctx.fillStyle=g;ctx.fill();
  ctx.strokeStyle='rgb(40,44,82)';ctx.lineWidth=4*s;for(let i=-2;i<=2;i++){ctx.beginPath();ctx.moveTo(x+i*botW/5,cabY);ctx.lineTo(x+i*topW/5,cabY-gH);ctx.stroke()}glow(x,cabY-gH/2,220*s,[255,190,120],.32*a);
  A(a);ctx.fillStyle='rgb(34,38,76)';ctx.fillRect(x-topW/2-10*s,cabY-gH-20*s,topW+20*s,20*s);ctx.fillRect(x-30*s,cabY-gH-34*s,60*s,14*s);ctx.strokeStyle='rgb(150,156,204)';ctx.lineWidth=3*s;ctx.beginPath();ctx.moveTo(x,cabY-gH-34*s);ctx.lineTo(x,cabY-gH-112*s);ctx.stroke();
  glow(x,cabY-gH-114*s,44*s,[255,50,50],a*(Math.sin(t*3.2)>0?1:.15))}return{gx:x,gy:cabY-gH*.5}}
function windsock(x,y,s,t,dirDeg=0,strength=.8,a=1){A(a);ctx.strokeStyle='rgb(150,156,204)';ctx.lineWidth=5*s;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y-160*s);ctx.stroke();
  ctx.save();ctx.translate(x,y-150*s);ctx.rotate(dirDeg*Math.PI/180+(1-strength)*1.1+Math.sin(t*3)*.05*strength);const L=130*s*(.55+.45*strength);
  for(let i=0;i<5;i++){const x0=i*L/5,x1=(i+1)*L/5,h0=lerp(22,10,i/5)*s,h1=lerp(22,10,(i+1)/5)*s,wv=Math.sin(t*8-i)*3*s*strength;A(a);ctx.fillStyle=i%2?'rgb(250,250,255)':'rgb(255,120,60)';ctx.beginPath();ctx.moveTo(x0,-h0+wv);ctx.lineTo(x1,-h1+wv);ctx.lineTo(x1,h1+wv);ctx.lineTo(x0,h0+wv);ctx.closePath();ctx.fill()}ctx.restore()}

/* ---------- aircraft ---------- */
/* planeSide(x,y,scale,dir ±1 (|dir|<1 squashes = turning),pitch rad,t,{a,ll:landingLight 0..1,acc:[r,g,b]}) nav light shows red facing left, green facing right */
function planeSide(x,y,s,dir,pitch,t,o={}){const a=o.a??1;if(a<=0.002)return;const acc=o.acc||COL.accent;ctx.save();ctx.translate(x,y);ctx.scale(dir*s,s);ctx.rotate(-pitch);
  if(o.ll){ctx.save();A(a*o.ll*.9);ctx.globalCompositeOperation='lighter';const g=ctx.createLinearGradient(150,0,620,0);g.addColorStop(0,'rgba(255,250,220,.35)');g.addColorStop(1,'rgba(255,250,220,0)');ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(150,4);ctx.lineTo(620,-70);ctx.lineTo(620,100);ctx.closePath();ctx.fill();ctx.restore()}
  A(a);ctx.fillStyle='rgb(186,192,222)';ctx.beginPath();ctx.ellipse(-148,-12,38,6,0,0,TAU);ctx.fill();ctx.fillStyle='rgb(234,236,250)';ctx.beginPath();ctx.moveTo(-104,-26);ctx.lineTo(-150,-98);ctx.lineTo(-178,-98);ctx.lineTo(-166,-18);ctx.closePath();ctx.fill();
  ctx.fillStyle=rgba(acc);ctx.beginPath();ctx.moveTo(-150,-98);ctx.lineTo(-178,-98);ctx.lineTo(-175,-78);ctx.lineTo(-137,-78);ctx.closePath();ctx.fill();
  let g=ctx.createLinearGradient(0,-54,0,18);g.addColorStop(0,'rgb(252,252,255)');g.addColorStop(.6,'rgb(222,226,244)');g.addColorStop(1,'rgb(156,162,196)');ctx.fillStyle=g;
  ctx.beginPath();ctx.moveTo(152,-2);ctx.quadraticCurveTo(146,-22,112,-26);ctx.lineTo(70,-30);ctx.quadraticCurveTo(40,-54,-2,-52);ctx.lineTo(-34,-44);ctx.quadraticCurveTo(-100,-30,-166,-20);ctx.lineTo(-168,-8);ctx.quadraticCurveTo(-60,14,60,17);ctx.quadraticCurveTo(136,17,152,6);ctx.closePath();ctx.fill();
  ctx.fillStyle=rgba(acc);ctx.beginPath();ctx.moveTo(132,-6);ctx.lineTo(-162,-13);ctx.lineTo(-162,-7);ctx.lineTo(132,2);ctx.closePath();ctx.fill();
  ctx.fillStyle='rgb(24,28,64)';ctx.beginPath();ctx.moveTo(66,-30);ctx.quadraticCurveTo(38,-50,0,-48);ctx.lineTo(-30,-41);ctx.lineTo(-30,-29);ctx.lineTo(60,-28);ctx.closePath();ctx.fill();
  ctx.strokeStyle='rgba(180,200,255,.6)';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(52,-34);ctx.quadraticCurveTo(32,-45,6,-44);ctx.stroke();
  if(o.flaps){ctx.save();ctx.translate(-50,12);ctx.rotate(o.flaps*.6);ctx.fillStyle='rgb(150,156,200)';ctx.fillRect(-26,-3,30,7);ctx.restore()}
  ctx.fillStyle='rgb(204,208,232)';ctx.beginPath();ctx.ellipse(22,10,76,9,0,0,TAU);ctx.fill();
  if(o.gear!==false){ctx.strokeStyle='rgb(88,94,130)';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(30,14);ctx.lineTo(24,40);ctx.moveTo(128,12);ctx.lineTo(126,36);ctx.stroke();ctx.fillStyle='rgb(36,38,58)';circle(24,42,10);ctx.fill();circle(126,38,8);ctx.fill()}
  ctx.fillStyle=rgba(acc);ctx.beginPath();ctx.ellipse(154,2,10,9,0,0,TAU);ctx.fill();A(a*.22);ctx.fillStyle='#fff';ctx.beginPath();ctx.ellipse(160,2,5,52,0,0,TAU);ctx.fill();ctx.restore();
  const L2S=(lx,ly)=>{const c=Math.cos(pitch),sn=Math.sin(pitch);const X=lx*c+ly*sn,Y=-lx*sn+ly*c;return[x+dir*s*X,y+s*Y]};
  let p=L2S(30,12);glow(p[0],p[1],30*s+6,dir>0?COL.green:COL.red,a*.95);p=L2S(-164,-100);glow(p[0],p[1],34*s+6,[255,60,60],a*(Math.sin(t*5+x*.01)>.55?1:0));
  p=L2S(-180,-14);glow(p[0],p[1],40*s+6,[255,255,255],a*((t*.9+x*.001)%1<.06?1:0))}
/* planeTop(x,y,scale,headingRad (0=east),t,{a,alt 0..1 (shadow offset = airborne),ll,acc}) */
function planeTop(x,y,s,hd,t,o={}){const a=o.a??1;if(a<=0.002)return;const alt=o.alt||0,acc=o.acc||COL.accent;
  const path=()=>{ctx.beginPath();ctx.moveTo(30,-14);ctx.lineTo(22,-150);ctx.lineTo(2,-150);ctx.lineTo(-8,-14);ctx.lineTo(-8,14);ctx.lineTo(2,150);ctx.lineTo(22,150);ctx.lineTo(30,14);ctx.closePath();
    ctx.moveTo(-112,-8);ctx.lineTo(-122,-62);ctx.lineTo(-140,-62);ctx.lineTo(-136,-8);ctx.closePath();ctx.moveTo(-112,8);ctx.lineTo(-122,62);ctx.lineTo(-140,62);ctx.lineTo(-136,8);ctx.closePath();
    ctx.moveTo(122,0);ctx.quadraticCurveTo(118,-17,92,-18);ctx.lineTo(-110,-11);ctx.quadraticCurveTo(-148,-8,-148,0);ctx.quadraticCurveTo(-148,8,-110,11);ctx.lineTo(92,18);ctx.quadraticCurveTo(118,17,122,0);ctx.closePath()};
  ctx.save();ctx.translate(x+alt*46,y+alt*70);ctx.rotate(hd);ctx.scale(s,s);A(a*.38*(1-alt*.5));ctx.fillStyle='#000';path();ctx.fill();ctx.restore();
  const k=s*(1+alt*.3);ctx.save();ctx.translate(x,y);ctx.rotate(hd);ctx.scale(k,k);A(a);ctx.fillStyle='rgb(206,210,234)';path();ctx.fill();
  ctx.fillStyle=rgba(acc);ctx.fillRect(4,-150,16,22);ctx.fillRect(4,128,16,22);const g=ctx.createLinearGradient(0,-18,0,18);g.addColorStop(0,'rgb(250,250,255)');g.addColorStop(1,'rgb(186,192,222)');ctx.fillStyle=g;
  ctx.beginPath();ctx.moveTo(122,0);ctx.quadraticCurveTo(118,-17,92,-18);ctx.lineTo(-110,-11);ctx.quadraticCurveTo(-148,-8,-148,0);ctx.quadraticCurveTo(-148,8,-110,11);ctx.lineTo(92,18);ctx.quadraticCurveTo(118,17,122,0);ctx.closePath();ctx.fill();
  ctx.fillStyle=rgba(acc);ctx.fillRect(-140,-3,250,6);ctx.fillStyle='rgb(24,28,64)';ctx.beginPath();ctx.ellipse(48,0,30,13,0,0,TAU);ctx.fill();A(a*.3);ctx.fillStyle='#fff';ctx.fillRect(124,-48,5,96);ctx.restore();
  const P=(lx,ly)=>[x+(lx*Math.cos(hd)-ly*Math.sin(hd))*k,y+(lx*Math.sin(hd)+ly*Math.cos(hd))*k];let p=P(12,-152);glow(p[0],p[1],22,COL.red,a*.95);p=P(12,152);glow(p[0],p[1],22,COL.green,a*.95);
  p=P(-146,0);glow(p[0],p[1],16,[255,255,255],a*.7);if(o.ll){p=P(150,0);glow(p[0],p[1],70*o.ll,[255,250,220],a*.5*o.ll)}}
/* planeFront(x,y,scale,rollRad,t,{a,ail -1..1,rud -1..1,nav 0..1,land 0..1}) wheels bottom ≈ y+96*scale */
function planeFront(x,y,s,roll,t,o={}){const a=o.a??1;if(a<=0.002)return;const acc=COL.accent,ail=o.ail||0,rud=o.rud||0;ctx.save();ctx.translate(x,y);ctx.rotate(roll);ctx.scale(s,s);A(a);
  ctx.fillStyle='rgb(222,226,244)';ctx.beginPath();ctx.moveTo(-7,-36);ctx.lineTo(-4+rud*14,-142);ctx.lineTo(4+rud*14,-142);ctx.lineTo(7,-36);ctx.closePath();ctx.fill();
  ctx.fillStyle=rgba(acc);ctx.beginPath();ctx.moveTo(-5+rud*11,-118);ctx.lineTo(-4+rud*14,-142);ctx.lineTo(4+rud*14,-142);ctx.lineTo(5+rud*11,-118);ctx.closePath();ctx.fill();ctx.fillStyle='rgb(196,200,226)';ctx.fillRect(-104,-38,208,8);
  const yt=X=>-6-(Math.abs(X)-30)/240*16;ctx.fillStyle='rgb(234,236,250)';ctx.beginPath();ctx.moveTo(-270,-22);ctx.lineTo(-30,-6);ctx.lineTo(30,-6);ctx.lineTo(270,-22);ctx.lineTo(270,-8);ctx.lineTo(30,10);ctx.lineTo(-30,10);ctx.lineTo(-270,-8);ctx.closePath();ctx.fill();
  ctx.fillStyle='rgba(120,126,172,.55)';ctx.beginPath();ctx.moveTo(-270,-10);ctx.lineTo(-30,8);ctx.lineTo(30,8);ctx.lineTo(270,-10);ctx.lineTo(270,-8);ctx.lineTo(30,10);ctx.lineTo(-30,10);ctx.lineTo(-270,-8);ctx.closePath();ctx.fill();
  if(Math.abs(ail)>.02)for(const sg of[-1,1]){const d=ail*sg*24,xa=sg*150,xb=sg*262;ctx.fillStyle='rgb(110,100,230)';ctx.beginPath();ctx.moveTo(xa,yt(xa)+d-3);ctx.lineTo(xb,yt(xb)+d-3);ctx.lineTo(xb,yt(xb)+d+9);ctx.lineTo(xa,yt(xa)+d+9);ctx.closePath();ctx.fill()}
  ctx.strokeStyle='rgb(88,94,132)';ctx.lineWidth=6;ctx.beginPath();ctx.moveTo(-56,8);ctx.lineTo(-70,72);ctx.moveTo(56,8);ctx.lineTo(70,72);ctx.moveTo(0,40);ctx.lineTo(0,78);ctx.stroke();
  ctx.fillStyle='rgb(36,38,58)';for(const[wx,wy] of[[-70,82],[70,82],[0,86]]){ctx.beginPath();ctx.ellipse(wx,wy,10,16,0,0,TAU);ctx.fill()}
  const g=ctx.createRadialGradient(-14,-16,4,0,4,50);g.addColorStop(0,'rgb(255,255,255)');g.addColorStop(1,'rgb(178,184,216)');ctx.fillStyle=g;ctx.beginPath();ctx.ellipse(0,4,46,44,0,0,TAU);ctx.fill();
  ctx.fillStyle='rgb(24,28,64)';ctx.beginPath();ctx.ellipse(0,-14,34,17,0,Math.PI,TAU);ctx.lineTo(34,-10);ctx.quadraticCurveTo(0,-2,-34,-10);ctx.closePath();ctx.fill();
  ctx.fillStyle=rgba(acc);circle(0,16,11);ctx.fill();A(a*.13);ctx.fillStyle='#fff';circle(0,16,64);ctx.fill();ctx.restore();
  const P=(lx,ly)=>[x+(lx*Math.cos(roll)-ly*Math.sin(roll))*s,y+(lx*Math.sin(roll)+ly*Math.cos(roll))*s];const nav=o.nav??.9;
  let p=P(-270,-15);glow(p[0],p[1],(40+60*nav)*s,COL.green,a*nav);p=P(270,-15);glow(p[0],p[1],(40+60*nav)*s,COL.red,a*nav);if(o.land>0){p=P(0,30);glow(p[0],p[1],260*s*o.land,[255,250,225],a*o.land)}}

/* ---------- cockpit instruments ---------- */
/* gauge(x,y,r,value,{min,max,label,unit,arcs:[[from,to,[r,g,b]]],a,startDeg,sweepDeg,major}) — airspeed/tach/any round dial */
function gauge(x,y,r,v,o={}){const a=o.a??1;if(a<=0.002)return;const mn=o.min??0,mx=o.max??200,s0=(o.startDeg??135)*Math.PI/180,sw=(o.sweepDeg??270)*Math.PI/180,ang=u=>s0+sw*clamp((u-mn)/(mx-mn));
  A(a);circle(x,y,r*1.08);ctx.fillStyle='rgb(30,32,52)';ctx.fill();circle(x,y,r);ctx.fillStyle='rgb(10,12,22)';ctx.fill();
  for(const[f,tt,c] of(o.arcs||[])){A(a);ctx.strokeStyle=rgba(c);ctx.lineWidth=r*.07;ctx.beginPath();ctx.arc(x,y,r*.86,ang(f),ang(tt));ctx.stroke()}
  const maj=o.major??(mx-mn)/10;ctx.strokeStyle='rgb(235,238,255)';ctx.lineCap='butt';for(let u=mn;u<=mx+1e-6;u+=maj/2){const an=ang(u),big=Math.abs((u-mn)/maj-Math.round((u-mn)/maj))<1e-6;ctx.lineWidth=big?r*.03:r*.015;ctx.beginPath();ctx.moveTo(x+Math.cos(an)*r*(big?.74:.8),y+Math.sin(an)*r*(big?.74:.8));ctx.lineTo(x+Math.cos(an)*r*.92,y+Math.sin(an)*r*.92);ctx.stroke();
    if(big&&o.numbers!==false)text(String(Math.round(u)),x+Math.cos(an)*r*.6,y+Math.sin(an)*r*.6,{size:r*.13,w:700,a,color:[220,224,250]})}
  if(o.label)text(o.label,x,y+r*.36,{size:r*.12,w:800,font:'Outfit',ls:2,a,color:COL.muted});if(o.unit)text(o.unit,x,y+r*.52,{size:r*.1,w:700,a,color:COL.muted});
  const an=ang(v);A(a);ctx.strokeStyle='rgb(255,255,255)';ctx.lineWidth=r*.05;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(x-Math.cos(an)*r*.12,y-Math.sin(an)*r*.12);ctx.lineTo(x+Math.cos(an)*r*.82,y+Math.sin(an)*r*.82);ctx.stroke();
  ctx.fillStyle='rgb(60,64,96)';circle(x,y,r*.08);ctx.fill()}
/* attitude(x,y,r,pitchDeg,rollDeg,a) — artificial horizon */
function attitude(x,y,r,pitch,roll,a=1){if(a<=0.002)return;A(a);circle(x,y,r*1.08);ctx.fillStyle='rgb(30,32,52)';ctx.fill();ctx.save();circle(x,y,r);ctx.clip();ctx.translate(x,y);ctx.rotate(-roll*Math.PI/180);const py=pitch*r/30;
  ctx.fillStyle='rgb(70,150,235)';ctx.fillRect(-2*r,-2*r+py,4*r,2*r);ctx.fillStyle='rgb(150,96,52)';ctx.fillRect(-2*r,py,4*r,2*r);ctx.strokeStyle='#fff';ctx.lineWidth=r*.025;ctx.beginPath();ctx.moveTo(-2*r,py);ctx.lineTo(2*r,py);ctx.stroke();
  for(const d of[-20,-10,10,20]){const yy=py-d*r/30,w=Math.abs(d)===10?r*.25:r*.4;ctx.beginPath();ctx.moveTo(-w/2,yy);ctx.lineTo(w/2,yy);ctx.stroke()}ctx.restore();
  A(a);ctx.strokeStyle='rgb(255,200,60)';ctx.lineWidth=r*.06;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(x-r*.55,y);ctx.lineTo(x-r*.18,y);ctx.lineTo(x-r*.1,y+r*.1);ctx.moveTo(x+r*.55,y);ctx.lineTo(x+r*.18,y);ctx.lineTo(x+r*.1,y+r*.1);ctx.stroke();ctx.fillStyle='rgb(255,200,60)';circle(x,y,r*.04);ctx.fill()}

/* ---------- maps & paths ---------- */
function pathLen(pts){let L=0;for(let i=0;i<pts.length-1;i++)L+=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]);return L}
function along(pts,f){const L=pathLen(pts);let d=clamp(f)*L;for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1],s=Math.hypot(b[0]-a[0],b[1]-a[1]);if(d<=s||i===pts.length-2){const q=s?clamp(d/s):0;return[lerp(a[0],b[0],q),lerp(a[1],b[1],q)]}d-=s}}
/* pathAt(points,f 0..1) -> {x,y,h} with smoothed heading for taxiing/flying along waypoints */
function pathAt(pts,f){const L=pathLen(pts),dl=26/L;const p=along(pts,f),p1=along(pts,Math.max(0,f-dl)),p2=along(pts,Math.min(1,f+dl));return{x:p[0],y:p[1],h:Math.atan2(p2[1]-p1[1],p2[0]-p1[0])}}
/* runwayTop(x0,y0,x1,y1 rect, numbers ['9','27']) — top-down runway with edge lights & markings */
function runwayTop(x0,y0,x1,y1,nums=['9','27'],o={}){A(1);ctx.fillStyle='rgb(44,46,62)';ctx.fillRect(x0,y0,x1-x0,y1-y0);const cy=(y0+y1)/2,h=y1-y0;ctx.fillStyle='rgba(255,255,255,.85)';
  for(let x=x0+170;x<x1-170;x+=92)ctx.fillRect(x,cy-4,52,8);for(let i=0;i<6;i++){ctx.fillRect(x0+18,y0+12+i*(h-24)/6,40,9);ctx.fillRect(x1-58,y0+12+i*(h-24)/6,40,9)}
  text(nums[0],x0+110,cy,{size:64,w:800,font:'Outfit',color:'rgba(255,255,255,.85)',rot:Math.PI/2});text(nums[1],x1-110,cy,{size:64,w:800,font:'Outfit',color:'rgba(255,255,255,.85)',rot:-Math.PI/2});
  for(let x=x0+20;x<=x1-20;x+=64){glow(x,y0-2,12,[255,240,200],.85);glow(x,y1+2,12,[255,240,200],.85)}}

/* ---------- cards ---------- */
function cardBox(y,h,a,border){A(a);ctx.beginPath();ctx.roundRect(60,y,960,h,34);ctx.fillStyle='rgba(12,14,42,.92)';ctx.fill();ctx.lineWidth=4;ctx.strokeStyle=rgba(border||[130,140,220],.8);ctx.stroke()}
/* infoCard: top card with eyebrow + big title (+ optional icon fn(x,y,a)) — the standard way to put the key term on screen */
function infoCard(eyebrow,main,a,o={}){if(a<=0.002)return;const y=o.y??250,h=o.h??200;const k=lerp(.94,1,eob(clamp(a)));ctx.save();ctx.translate(540,y+h/2);ctx.scale(k,k);ctx.translate(-540,-(y+h/2));
  cardBox(y,h,a,o.border);const x0=o.icon?250:110;if(o.icon)o.icon(160,y+h/2,a);
  if(eyebrow)text(eyebrow,x0,y+h*.32,{size:30,w:800,font:'Outfit',ls:5,color:o.eyeCol||COL.muted,align:'left',a});
  const ma=o.tm!=null?pop(o.tm,.45):1;if(ma>0)text(main,x0,y+h*(eyebrow?.64:.5),{size:fit(main,980-x0-40,o.size||58,800,'Outfit',2),w:800,font:'Outfit',ls:2,align:'left',a:a*clamp(ma)});ctx.restore()}
function sunIcon(x,y,r,a){glow(x,y,r*3,[255,210,110],.6*a);A(a);ctx.fillStyle='rgb(255,206,92)';circle(x,y,r);ctx.fill();ctx.strokeStyle='rgb(255,206,92)';ctx.lineWidth=r*.18;ctx.lineCap='round';for(let i=0;i<8;i++){const an=i/8*TAU;ctx.beginPath();ctx.moveTo(x+Math.cos(an)*r*1.35,y+Math.sin(an)*r*1.35);ctx.lineTo(x+Math.cos(an)*r*1.75,y+Math.sin(an)*r*1.75);ctx.stroke()}}
function moonIcon(x,y,r,a,bg='rgb(12,14,42)'){glow(x,y,r*2.6,[200,210,255],.35*a);A(a);ctx.fillStyle='rgb(226,230,255)';circle(x,y,r);ctx.fill();ctx.fillStyle=bg;circle(x+r*.45,y-r*.3,r*.86);ctx.fill()}
function stopSign(x,y,k,a){if(a<=0.002)return;ctx.save();ctx.translate(x,y);ctx.scale(k,k);A(a);ctx.beginPath();for(let i=0;i<8;i++){const an=Math.PI/8+i*TAU/8;i?ctx.lineTo(Math.cos(an)*54,Math.sin(an)*54):ctx.moveTo(Math.cos(an)*54,Math.sin(an)*54)}ctx.closePath();ctx.fillStyle=rgba(COL.red);ctx.fill();ctx.lineWidth=5;ctx.strokeStyle='#fff';ctx.stroke();ctx.restore();ctx.save();ctx.translate(x,y);ctx.scale(k,k);text('STOP',0,2,{size:30,w:800,font:'Outfit',a});ctx.restore()}
/* table(x,y,w,rows,cols,{a,t0,t}) — recap table; rows = [[cellA,cellB,...]] strings */
function table(x,y,w,head,rows,o={}){const a=o.a??1;if(a<=0.002)return;const cw=o.colW||head.map(()=>w/head.length),rh=o.rowH||120;let cx=x;
  head.forEach((h,i)=>{text(h,cx+cw[i]/2,y,{size:26,w:800,font:'Outfit',ls:4,color:(o.headCol&&o.headCol[i])||COL.muted,a});cx+=cw[i]});
  rows.forEach((r,j)=>{const ya=y+30+j*rh,ra=a*(o.t!=null?ap(o.t-o.t0-j*.16,.35):1);if(ra<=0)return;A(ra*.5);ctx.fillStyle='rgba(160,170,240,.35)';ctx.fillRect(x,ya,w,2);let cx2=x;
    r.forEach((c,i)=>{const L=wrap(c,cw[i]-24,o.size||32,700);L.forEach((l,k)=>text(l,cx2+cw[i]/2,ya+rh/2+(k-(L.length-1)/2)*(o.size||32)*1.25,{size:o.size||32,w:i===0?800:700,a:ra,color:i===0&&o.firstCol?o.firstCol(j):COL.white}));cx2+=cw[i]})})}

/* ---------- captions / chapter labels / overlays ---------- */
function buildCaps(){for(const s of TL.scenes)for(const L of s.lines)for(const S of L.sents){let cur=null;
  for(const tk of S.tokens){if(!cur||(cur.text+' '+tk.text).length>26){if(cur)CAPS.push(cur);cur={text:tk.text,start:tk.start,end:tk.end}}else{cur.text+=' '+tk.text;cur.end=tk.end}
    if(/[,;:]$/.test(tk.text)&&cur.text.length>12){CAPS.push(cur);cur=null}}if(cur)CAPS.push(cur)}}
function drawCaption(t){let c=null;for(let i=0;i<CAPS.length;i++){const k=CAPS[i],nx=CAPS[i+1];if(t>=k.start-.05&&t<(nx?Math.min(nx.start-.05,k.end+.5):k.end+.5)){c=k;break}}
  if(!c)return;const a=ap(t-c.start+.05,.08),k=lerp(.9,1,eob(clamp((t-c.start+.05)/.18)));ctx.save();ctx.translate(CX,1660);ctx.scale(k,k);text(c.text,0,0,{size:58,w:800,color:COL.white,a,stroke:14,strokeCol:'rgba(8,6,24,.92)'});ctx.restore()}
function drawChapter(t){for(let i=0;i<TL.scenes.length;i++){const s0=i===0?.6:trS(i)+.5;const a=win(t,s0,s0+4.2,.6,.8);if(a<=0)continue;const dx=(1-eout(clamp((t-s0)/.7)))*-30;
  A(a);ctx.fillStyle=rgba(COL.green);ctx.fillRect(72+dx,128,56,5);text(String(i+1).padStart(2,'0'),72+dx,170,{size:34,w:800,font:'Outfit',color:COL.green,a,align:'left',ls:2});
  text(sc(i).title.toUpperCase(),132+dx,170,{size:34,w:700,font:'Outfit',color:COL.white,a,align:'left',ls:5})}}
let VIG,GRAIN;
function makeOverlays(){VIG=document.createElement('canvas');VIG.width=W;VIG.height=H;let g=VIG.getContext('2d');const gr=g.createRadialGradient(CX,900,320,CX,900,1280);gr.addColorStop(0,'rgba(0,0,0,0)');gr.addColorStop(1,'rgba(0,0,0,.6)');g.fillStyle=gr;g.fillRect(0,0,W,H);
  const cap=g.createLinearGradient(0,1480,0,H);cap.addColorStop(0,'rgba(0,0,0,0)');cap.addColorStop(1,'rgba(0,0,0,.6)');g.fillStyle=cap;g.fillRect(0,1480,W,440);
  GRAIN=document.createElement('canvas');GRAIN.width=GRAIN.height=512;g=GRAIN.getContext('2d');const id=g.createImageData(512,512);const r=rng(3);for(let i=0;i<id.data.length;i+=4){const v=r()*255;id.data[i]=id.data[i+1]=id.data[i+2]=v;id.data[i+3]=255}g.putImageData(id,0,0)}

/* ---------- frame loop ---------- */
function renderFrame(t){const R=FILM.scenes;GA=1;ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
  let i=0;for(let k=1;k<R.length;k++)if(t>=trS(k))i=k;const e=i>0?eio((t-trS(i))/.9):1;
  if(e<1){GA=1;R[i-1](t);GA=e;ctx.save();const k=lerp(1.06,1,e);ctx.translate(540,900);ctx.scale(k,k);ctx.translate(-540,-900);R[i](t);ctx.restore()}else{GA=1;R[i](t)}
  GA=1;ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.drawImage(VIG,0,0);
  ctx.globalAlpha=.04;ctx.globalCompositeOperation='overlay';const ox=(Math.floor(t*30)*137)%512,oy=(Math.floor(t*30)*311)%512;for(let y=-oy;y<H;y+=512)for(let x=-ox;x<W;x+=512)ctx.drawImage(GRAIN,x,y);
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;if(FILM.overlay)FILM.overlay(t);drawChapter(t);drawCaption(t);
  const blk=Math.max(1-ap(t,.6),ap(t-(TL.duration-1.6),1.4));if(blk>0){ctx.globalAlpha=blk;ctx.fillStyle='#000';ctx.fillRect(0,0,W,H);ctx.globalAlpha=1}}
window.frame=t=>{renderFrame(t);return cv.toDataURL('image/jpeg',.93)};
window.still=t=>{renderFrame(t);return cv.toDataURL('image/png')};
(async()=>{TL=await (await fetch('timeline.json')).json();
  for(const[n,u] of [['Outfit','fonts/Outfit.ttf'],['Figtree','fonts/Figtree.ttf']]){const f=new FontFace(n,`url(${u})`,{weight:'100 900'});await f.load();document.fonts.add(f)}
  await document.fonts.ready;makeOverlays();buildCaps();
  for(let k=1;k<TL.scenes.length;k++)ev(trS(k)-.15,'whoosh');
  if(FILM.setup)FILM.setup();window.EV=EV;window.DUR=TL.duration;window.READY=true})();
```

## File: render.js

```javascript
// node render.js DIR PORT stills t1,t2,...  |  node render.js DIR PORT events  |  node render.js DIR PORT video out.mp4 [from to]
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
let pw; for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright', path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')]) { try { pw = require(p); break; } catch (e) {} }
(async () => {
  const [, , dir, port, mode, arg, s0, s1] = process.argv;
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/film.html`);
  await page.waitForFunction('window.READY===true', null, { timeout: 60000 });
  const dur = await page.evaluate('window.DUR');
  if (mode === 'events') fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(await page.evaluate('window.EV')));
  else if (mode === 'stills') {
    const out = path.join(dir, 'stills'); fs.mkdirSync(out, { recursive: true });
    for (const t of arg.split(',').map(Number)) { const d = await page.evaluate(t => window.still(t), t); fs.writeFileSync(path.join(out, `t${t.toFixed(1).padStart(6, '0')}.png`), Buffer.from(d.split(',')[1], 'base64')); }
  } else {
    const fps = 30, a = Number(s0 || 0), b = Number(s1 || dur);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', '1', arg], { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now();
    for (let f = Math.round(a * fps); f < Math.round(b * fps); f++) {
      const d = await page.evaluate(t => window.frame(t), f / fps); const buf = Buffer.from(d.slice(d.indexOf(',') + 1), 'base64');
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (f % 300 === 0) console.log(`frame ${f}/${Math.round(b * fps)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end(); await new Promise(r => ff.on('close', r)); console.log('VIDEO DONE');
  }
  await browser.close();
})();
```

## File: soundtrack.py

```python
"""Soundtrack: narration + ducked music bed + event-synced SFX.
usage: python3 soundtrack.py DIR [--mood bright|calm|tense]   (DIR has narration.wav, timeline.json, events.json) -> DIR/mix.wav
Event types: whoosh swoosh zoom click static stamp beep ping flare title gun pop tick stopsign chime boom shimmer engine(d) wind(d) alarm"""
import json, wave, sys, argparse
import numpy as np
from scipy.signal import butter, sosfiltfilt, resample_poly

ap_ = argparse.ArgumentParser(); ap_.add_argument('dir'); ap_.add_argument('--mood', default='bright', choices=['bright', 'calm', 'tense']); ARGS = ap_.parse_args()
DIRP = ARGS.dir.rstrip('/')
SR = 48000
TL = json.load(open(f'{DIRP}/timeline.json'))
EV = json.load(open(f'{DIRP}/events.json'))
DUR = TL['duration']
N = int(DUR * SR) + SR
rng = np.random.default_rng(11)
hz = lambda n: 440 * 2 ** ((n - 69) / 12)
lp = lambda x, f: sosfiltfilt(butter(2, f, 'lp', fs=SR, output='sos'), x, axis=0)
hpf = lambda x, f: sosfiltfilt(butter(2, f, 'hp', fs=SR, output='sos'), x, axis=0)
bp = lambda x, a, b: sosfiltfilt(butter(2, [a, b], 'bp', fs=SR, output='sos'), x, axis=0)

# ---------- narration ----------
with wave.open(f'{DIRP}/narration.wav') as w:
    nsr = w.getframerate(); nar = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
if nsr != SR: nar = resample_poly(nar, SR, nsr)   # tts_av.py already outputs 48 kHz with clarity processing
narr = np.zeros(N, np.float32); narr[:len(nar)] = nar[:N]

# ---------- music: warm pad + soft pulse arpeggio ----------
MOODS = {'bright': [[50, 57, 62, 66, 69], [47, 54, 59, 62, 66], [43, 50, 55, 59, 62], [45, 52, 57, 61, 64]],   # D Bm G A
         'calm': [[53, 57, 60, 64, 67], [57, 60, 64, 67, 71], [50, 57, 60, 64, 65], [48, 55, 59, 64, 67]],     # Fmaj7 Am7 Dm9 Cmaj7
         'tense': [[45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [43, 50, 55, 58, 62], [40, 47, 52, 56, 59]]}    # Am F Gm E
CH = MOODS.get(ARGS.mood, MOODS['bright'])
SEG = 4 * 60 / 96 * 2  # two bars at 96 bpm
pad = np.zeros((N, 2), np.float32)
for k in range(int(DUR / SEG) + 2):
    t0 = k * SEG - 1.5
    a, b = max(0, int(t0 * SR)), min(N, int((t0 + SEG + 3) * SR))
    if a >= b: continue
    t = np.arange(a, b) / SR; lt = t - t0
    env = np.sin(np.clip(lt / 2.0, 0, 1) * np.pi / 2) ** 2 * np.sin(np.clip((SEG + 3 - lt) / 2.0, 0, 1) * np.pi / 2) ** 2
    ch = CH[k % 4]
    for c in (0, 1):
        sig = np.zeros_like(t)
        for n in ch:
            f = hz(n) * (1 + (0.002 if c else -0.002))
            for h, am in ((1, 1), (2, .28), (3, .1)):
                sig += am * np.sin(2 * np.pi * f * h * t + n * 0.7 + h + c)
        sig += 0.8 * np.sin(2 * np.pi * hz(ch[0] - 12) * t)
        pad[a:b, c] += (sig * env).astype(np.float32)
pad = lp(pad, 1600).astype(np.float32)
arp = np.zeros((N, 2), np.float32)
step = 60 / 96 / 2
i = 0; t = 2.0
while t < DUR - 3:
    k = int((t + 1.5) / SEG) % 4; ch = CH[k]
    n = ch[[0, 2, 3, 4, 3, 2, 1, 2][i % 8]] + 12
    L = int(.5 * SR); tt = np.arange(L) / SR
    tone = (np.sin(2 * np.pi * hz(n) * tt) + .25 * np.sin(4 * np.pi * hz(n) * tt)) * np.exp(-tt * 9) * (1 - np.exp(-tt * 300))
    i0 = int(t * SR); m = min(L, N - i0); pan = .3 + .4 * ((i % 4) / 3)
    arp[i0:i0 + m, 0] += tone[:m] * (1 - pan); arp[i0:i0 + m, 1] += tone[:m] * pan
    t += step; i += 1
d = int(step * 3 * SR); arp[d:] += .35 * arp[:-d][:, ::-1]
arp = lp(arp, 3000).astype(np.float32)
music = pad / np.abs(pad).max() * 0.15 + arp / np.abs(arp).max() * 0.05
envn = np.convolve(np.abs(narr), np.ones(4800) / 4800, 'same'); envn = np.convolve(envn, np.ones(9600) / 9600, 'same')
music *= (1 - 0.5 * np.clip(envn / 0.04, 0, 1))[:, None]
tt = np.arange(N) / SR
music *= (np.clip(tt / 2.0, 0, 1) * np.clip((DUR - tt) / 3.0, 0, 1))[:, None]

# ---------- sfx ----------
sfx = np.zeros((N, 2), np.float32)
def add(sig, at, pan=.5, gain=1.0):
    i0 = int(at * SR)
    if i0 < 0: sig, i0 = sig[-i0:], 0                  # event starts before t=0: keep the audible tail, don't drop it
    m = min(len(sig), N - i0)
    if m <= 0: return
    sfx[i0:i0 + m, 0] += sig[:m] * gain * (1 - pan) * 2 ** .5
    sfx[i0:i0 + m, 1] += sig[:m] * gain * pan * 2 ** .5
def norm(x): return (x / max(1e-9, np.abs(x).max())).astype(np.float32)
def svf(x, fc, q=1.0):
    y = np.zeros_like(x); low = band = 0.0; f = 2 * np.sin(np.pi * np.clip(fc, 20, SR / 6) / SR); damp = 1 / q
    for i in range(len(x)):
        high = x[i] - low - damp * band; band += f[i] * high; low += f[i] * band; y[i] = band
    return y
def whoosh(dur, up=True, q=1.2):
    L = int((dur + .6) * SR); t = np.arange(L) / SR; p = np.clip(t / dur, 0, 1)
    fc = 300 * (20 ** (p if up else 1 - p))
    y = svf(rng.standard_normal(L), fc, q)
    return norm(y * np.sin(np.pi * np.clip(t / (dur + .5), 0, 1)) ** 1.5)
def tone(f, dur, dec, att=400):
    t = np.arange(int(dur * SR)) / SR
    return (np.sin(2 * np.pi * f * t) * np.exp(-t * dec) * (1 - np.exp(-t * att))).astype(np.float32)
def thump(f0=70, dur=.5):
    t = np.arange(int(dur * SR)) / SR; f = f0 + 60 * np.exp(-t * 30)
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)).astype(np.float32)
def click(dur=.03, f=3000):
    L = int(dur * SR); t = np.arange(L) / SR
    return norm(bp(rng.standard_normal(L), f * .6, min(f * 1.6, 20000)) * np.exp(-t * 180))
def shimmer(base=74, dur=3.0):
    t = np.arange(int(dur * SR)) / SR; out = np.zeros_like(t)
    for j, n in enumerate([base, base + 5, base + 7, base + 12, base + 14, base + 19]):
        m = t >= j * .06; u = t[m] - j * .06
        out[m] += np.sin(2 * np.pi * hz(n) * u) * np.exp(-u * 1.8) * (1 - np.exp(-u * 40))
    return norm(out)
def static(dur=1.1):
    L = int(dur * SR); t = np.arange(L) / SR
    n = bp(rng.standard_normal(L), 900, 6000); crack = (rng.random(L) < .004) * rng.standard_normal(L) * 6
    env = np.exp(-t * 1.2) * (1 - np.exp(-t * 80))
    return norm((n + crack) * env)
def gun():
    s = thump(55, .45) * .9; c = click(.025, 2400) * .8; s[:len(c)] += c
    t = np.arange(int(.35 * SR)) / SR
    hum = (np.sin(2 * np.pi * 120 * t) + .5 * np.sin(2 * np.pi * 240 * t)) * np.exp(-t * 7) * .15
    out = np.zeros(int(.5 * SR), np.float32); out[:len(s)] += s; out[:len(hum)] += hum
    return norm(out)
def boom(dur=1.4):
    t = np.arange(int(dur * SR)) / SR; f = 38 + 50 * np.exp(-t * 9)
    nz = lp(rng.standard_normal(len(t)), 900) * np.exp(-t * 14) * .9
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3.2) + nz)
def windnoise(dur):
    L = int(dur * SR); t = np.arange(L) / SR
    return norm(svf(rng.standard_normal(L), 400 + 300 * np.sin(t * 1.3) ** 2, 2.0) * np.clip(t / .8, 0, 1) * np.clip((dur - t) / .8, 0, 1))
def alarm(dur=1.2):
    t = np.arange(int(dur * SR)) / SR
    return norm(np.sign(np.sin(2 * np.pi * 880 * t)) * .3 * ((t * 4) % 1 < .5) * np.clip((dur - t) / .1, 0, 1))
def engine(dur):
    L = int(dur * SR); t = np.arange(L) / SR; p = np.clip(t / (dur * .8), 0, 1)
    f = 85 + 70 * p ** 1.5
    ph = 2 * np.cumsum(f) / SR
    saw = 2 * (ph % 1) - 1
    rumble = lp(rng.standard_normal(L), 400) * 2
    env = np.clip(t / .5, 0, 1) * np.clip((dur - t) / .9, 0, 1) * (.5 + .5 * p)
    return norm(lp(saw * .7 + rumble, 900) * env)

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'whoosh': add(whoosh(1.0), t - .3, .5, .32)
    elif ty == 'swoosh': add(whoosh(.6, True, 1.5), t - .1, .5, .22)
    elif ty == 'zoom': add(whoosh(1.7, True), t - .1, .5, .38)
    elif ty == 'click': add(click(.04, 2200), t, .55, .5); add(click(.03, 1500), t + .14, .55, .35)
    elif ty == 'static': add(static(1.15), t, .5, .4)
    elif ty == 'stamp': add(thump(60, .5), t, .5, .6); add(click(.05, 1200), t, .5, .4)
    elif ty == 'beep': add(tone(1320, .09, 30), t, .55, .25)
    elif ty == 'ping': p = tone(1150, 1.4, 3.5); add(p, t, .65, .25); add(p, t + .35, .35, .1)
    elif ty == 'flare': add(thump(48, 1.2), t, .5, .7); add(shimmer(81, 3.0), t + .05, .5, .32)
    elif ty == 'title': add(shimmer(74, 3.5), t, .5, .28)
    elif ty == 'gun': add(gun(), t, .5, .42)
    elif ty == 'pop': add(tone(880, .18, 24) + .4 * tone(1320, .18, 30)[:int(.18 * SR)], t, .5, .16)
    elif ty == 'tick': add(click(.02, 3500), t, .4 + .2 * rng.random(), .25)
    elif ty == 'stopsign': a_ = tone(330, .35, 10); a_[:len(tone(220, .35, 10))] += .5 * tone(220, .35, 10); add(a_, t, .5, .3)
    elif ty == 'chime': a_ = tone(hz(86), 1.4, 3.0); b_ = tone(hz(98), 1.0, 4); a_[:len(b_)] += .3 * b_; add(a_, t, .5, .14)
    elif ty in ('takeoff', 'engine'): add(engine(e.get('d', 3.0)), t - .3, .55, .5)
    elif ty == 'boom': add(boom(), t, .5, .6)
    elif ty == 'shimmer': add(shimmer(e.get('note', 76), 3.0), t, .5, .28)
    elif ty == 'wind': add(windnoise(e.get('d', 3.0)), t, .5, .3)
    elif ty == 'alarm': add(alarm(e.get('d', 1.2)), t, .5, .25)

mix = music + sfx * 0.6 + narr[:, None] * 0.95
mix = np.tanh(mix * 1.1) / np.tanh(1.1)
mix = mix[:int(DUR * SR)]
with wave.open(f'{DIRP}/mix.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes())
print('mix ok', round(mix.shape[0] / SR, 1), 'peak', round(float(np.abs(mix).max()), 3))
```

## File: film_template.html
Copy to <slug>/film.html and replace the scenes. Matching test script: [{"title":"Final","lines":["You are on short final.","Steady green. Cleared to land."]},{"title":"Recap","lines":["That is all you need."]}]
```html
<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head>
<body><canvas id="c" width="1080" height="1920"></canvas><script src="engine.js"></script><script>
// One function per chapter (same order as script.json). Each paints the FULL frame and must look right after its chapter ends.
function ch0(t){
  sky(t,0,1330); runwaySide(t);
  const tw=tower(150,1330,1,t);
  const u=t-st(0,0);                                    // seconds since line 0 started
  const x=lerp(1150,640,clamp(u/3)), y=lerp(820,1280,clamp(u/3));
  planeSide(x,y,.8,-1,.08,t,{ll:1});
  const S=blink('steady',t-st(0,1),COL.green);          // light comes on when line 1 starts
  beam(tw.gx,tw.gy,x,y,S.col,S.i,lineA(0,1,t));
  infoCard('IN THE AIR','CLEARED TO LAND',lineA(0,1,t),{icon:(cx,cy,a)=>lamp(cx,cy,48,S,a,COL.green),tm:t-at(0,1,'cleared')});
}
function ch1(t){
  gridBG(t);
  table(60,400,960,['SIGNAL','IN THE AIR','ON THE GROUND'],[['Steady green','Cleared to land','Cleared for takeoff']],
        {t,t0:st(1,0),rowH:150,colW:[300,330,330],headCol:[COL.muted,COL.blue,COL.amber]});
}
window.FILM={scenes:[ch0,ch1],
  setup(){ ev(st(0,1),'gun'); ev(at(0,1,'cleared'),'pop'); }};
</script></body></html>
```
