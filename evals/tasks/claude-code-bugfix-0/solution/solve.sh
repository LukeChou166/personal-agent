#!/bin/bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path

path = Path("/app/buggy.py")
text = path.read_text()
text = text.replace("return a - b", "return a + b")
path.write_text(text)
PY
