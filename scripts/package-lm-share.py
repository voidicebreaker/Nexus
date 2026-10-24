"""Build the Windows download from its reviewed source files, deterministically."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import sys

root = Path(__file__).resolve().parents[1]
desktop = root / 'ai' / 'desktop'
files = ['Start-LM-Share.cmd', 'Start-Permanent-Tunnel.cmd', 'Reset-Access-Key.cmd', 'bootstrap.ps1', 'relay.mjs', 'README.txt']
if '--check' in sys.argv:
    with ZipFile(desktop / 'LM-Studio-Sharing-Windows.zip') as archive:
        expected = {'LM-Studio-Sharing-Windows/' + name for name in files}
        assert set(archive.namelist()) == expected, 'Unexpected files in the Windows ZIP'
        assert archive.testzip() is None, 'Windows ZIP integrity check failed'
        for name in files:
            saved = archive.read('LM-Studio-Sharing-Windows/' + name).replace(b'\r\n', b'\n')
            source = (desktop / name).read_bytes().replace(b'\r\n', b'\n')
            assert saved == source, f'Regenerate the Windows ZIP after editing {name}'
    print('Windows ZIP matches all launcher source files')
    sys.exit(0)
with ZipFile(desktop / 'LM-Studio-Sharing-Windows.zip', 'w', compression=ZIP_DEFLATED) as archive:
    for name in files:
        info = ZipInfo('LM-Studio-Sharing-Windows/' + name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        data = (desktop / name).read_bytes().replace(b'\r\n', b'\n')
        if name.endswith(('.cmd', '.ps1', '.txt')):
            data = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        archive.writestr(info, data)
print('Built ai/desktop/LM-Studio-Sharing-Windows.zip')
