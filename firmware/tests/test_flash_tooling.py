"""Guards for the host flashing tooling (PR #321).

esptool v5 renamed every command (`erase_flash` -> `erase-flash`) and moved from
`esptool.py` to a plain `esptool` console script. The old spellings still work
today but emit deprecation warnings and are scheduled for removal in the next
major release, so a reintroduced one would be a silent time bomb: these scripts
are never exercised in CI, only on a maintainer's desk with hardware attached.

The mip manifest name is guarded for a different reason. Dependabot's pip
fetcher treats any file whose name contains "requirements" as a pip manifest,
so naming the MicroPython package list `requirements.txt` inside a directory
covered by a pip ecosystem entry makes it try to resolve `aioble` against PyPI,
where an unrelated abandoned package of that name lives.

Run: python -m unittest discover -s firmware/tests
"""

import os
import re
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_ROOT = os.path.abspath(os.path.join(_FIRMWARE_DIR, ".."))

_SOURCES = [
    os.path.join(_FIRMWARE_DIR, "flash.sh"),
    os.path.join(_ROOT, "drivers", "build.sh"),
    os.path.join(_ROOT, "docs", "guide", "esp32-proxy.md"),
]

_LEGACY_ENTRY_POINT = re.compile(r"\besptool\.py\b")
_LEGACY_SUBCOMMANDS = re.compile(r"\b(erase_flash|write_flash|read_flash|chip_id|flash_id)\b")


def _read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


class FlashToolingTest(unittest.TestCase):
    def test_no_legacy_esptool_entry_point(self):
        for path in _SOURCES:
            self.assertTrue(os.path.exists(path), f"{path} is missing")
            self.assertIsNone(
                _LEGACY_ENTRY_POINT.search(_read(path)),
                f"{os.path.basename(path)} still calls esptool.py; "
                "esptool v5 uses the `esptool` console script",
            )

    def test_no_underscore_subcommands(self):
        for path in _SOURCES:
            self.assertIsNone(
                _LEGACY_SUBCOMMANDS.search(_read(path)),
                f"{os.path.basename(path)} still uses an underscore esptool subcommand; "
                "v5 spells them with hyphens",
            )

    def test_v5_command_names_present(self):
        text = _read(os.path.join(_FIRMWARE_DIR, "flash.sh"))
        for command in ("erase-flash", "write-flash", "chip-id"):
            self.assertIn(command, text, f"flash.sh no longer runs `{command}`")

    def test_mip_manifest_is_not_named_requirements(self):
        self.assertTrue(
            os.path.exists(os.path.join(_FIRMWARE_DIR, "mip-packages.txt")),
            "the MicroPython package list is missing",
        )
        self.assertFalse(
            os.path.exists(os.path.join(_FIRMWARE_DIR, "requirements.txt")),
            "firmware/requirements.txt would be picked up by the Dependabot pip ecosystem "
            "entry for /firmware, which must only ever see requirements-flash.txt",
        )

    def test_host_tools_are_pinned(self):
        text = _read(os.path.join(_FIRMWARE_DIR, "requirements-flash.txt"))
        pins = [
            line.strip()
            for line in text.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        self.assertTrue(pins, "requirements-flash.txt declares no host tools")
        for pin in pins:
            self.assertIn("==", pin, f"host tool `{pin}` is not pinned to an exact version")


if __name__ == "__main__":
    unittest.main()
