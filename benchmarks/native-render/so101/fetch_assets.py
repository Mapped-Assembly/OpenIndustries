"""Download hash-pinned upstream SO-101 assets without requiring Node or Chromium."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def main() -> None:
    """Verify cached files or fetch exact upstream bytes and verify their hashes."""
    root = Path(__file__).resolve().parent
    lock = json.loads((root / 'source-lock.json').read_text())
    base = f"https://raw.githubusercontent.com/{lock['repository']}/{lock['commit']}/Simulation/SO101/"
    for name, expected in lock['files'].items():
        path = root / 'cache' / name
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
            continue
        url = base + ('so101_new_calib.xml' if name == 'so101.xml' else name)
        with urlopen(url, timeout=60) as response:
            raw = response.read()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError(f'Upstream hash mismatch: {name}')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    print('Verified pinned SO-101 model and meshes')


if __name__ == '__main__':
    main()
