"""Exercise the native window CLI under a desktop display or xvfb-run."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    """Require live rendered frames as well as a physically successful task."""
    with tempfile.TemporaryDirectory() as folder:
        report = Path(folder)/'window.json'
        subprocess.run([sys.executable, str(ROOT/'tools/geospatial/live_runtime.py'),
                        str(ROOT/'benchmarks/live-runtime/gate'), '--view', 'window',
                        '--max-wall', '60', '--report', str(report)], check=True)
        result = json.loads(report.read_text())
        if not result['assessment']['success'] or result['frames'] < 2:
            raise AssertionError('Native window did not continuously render the live simulation')
        print(f'Native window: {result["frames"]} live frames, task verified')


if __name__ == '__main__':
    main()
