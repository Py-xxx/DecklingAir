"""
Voicemeeter Remote API wrapper using ctypes.
Supports VoiceMeeter, Banana, and Potato.
"""
import ctypes
import os
import logging

log = logging.getLogger(__name__)

DLL_PATHS = [
    r"C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll",
    r"C:\Program Files\VB\Voicemeeter\VoicemeeterRemote64.dll",
    r"C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote.dll",
]

VM_TYPE_NAMES = {1: "VoiceMeeter", 2: "VoiceMeeter Banana", 3: "VoiceMeeter Potato"}

# Potato has 8 strips (5 HW + 3 virt) and 8 buses (5 HW A1-A5 + 3 virt B1-B3)
STRIP_COUNT = 8
BUS_COUNT = 8

STRIP_FLOAT_PARAMS = [
    "Gain", "Pan_x", "Pan_y",
    "EqGain1", "EqGain2", "EqGain3",
    "Comp", "Gate", "Karaoke",
]
STRIP_BOOL_PARAMS = [
    "Mute", "Solo", "MC",
    "A1", "A2", "A3", "A4", "A5",
    "B1", "B2", "B3",
]
BUS_FLOAT_PARAMS = ["Gain"]
BUS_BOOL_PARAMS  = ["Mute", "EQ.on"]


class VoiceMeeterRemote:
    def __init__(self):
        self._dll = None

    def initialize(self) -> bool:
        """Load the DLL. Returns True on success."""
        for path in DLL_PATHS:
            if os.path.exists(path):
                try:
                    self._dll = ctypes.windll.LoadLibrary(path)
                    log.info("Loaded DLL: %s", path)
                    return True
                except OSError as e:
                    log.warning("Failed to load %s: %s", path, e)
        log.error("VoiceMeeter DLL not found. Is VoiceMeeter installed?")
        return False

    def login(self) -> int:
        """
        Returns:
          0  = OK, already running
          1  = OK, VoiceMeeter launched
         -1  = cannot get client (unexpected error)
         -2  = VoiceMeeter not installed
        """
        return self._dll.VBVMR_Login()

    def logout(self) -> int:
        return self._dll.VBVMR_Logout()

    def get_type(self) -> int:
        """Returns VM type: 1=VM, 2=Banana, 3=Potato"""
        t = ctypes.c_long(0)
        self._dll.VBVMR_GetVoicemeeterType(ctypes.byref(t))
        return t.value

    def get_version(self) -> str:
        v = ctypes.c_long(0)
        self._dll.VBVMR_GetVoicemeeterVersion(ctypes.byref(v))
        raw = v.value
        v1 = (raw >> 24) & 0xFF
        v2 = (raw >> 16) & 0xFF
        v3 = (raw >> 8) & 0xFF
        v4 = raw & 0xFF
        return f"{v1}.{v2}.{v3}.{v4}"

    def is_dirty(self) -> bool:
        """True if parameters changed since last call."""
        return self._dll.VBVMR_IsParametersDirty() == 1

    # ── Float parameters ───────────────────────────────────────────────────────

    def get_float(self, param: str) -> float:
        val = ctypes.c_float(0.0)
        r = self._dll.VBVMR_GetParameterFloat(
            ctypes.c_char_p(param.encode("ascii")),
            ctypes.byref(val)
        )
        if r != 0:
            raise RuntimeError(f"GetParameterFloat({param}) returned {r}")
        return round(float(val.value), 4)

    def set_float(self, param: str, value: float):
        r = self._dll.VBVMR_SetParameterFloat(
            ctypes.c_char_p(param.encode("ascii")),
            ctypes.c_float(value)
        )
        if r != 0:
            raise RuntimeError(f"SetParameterFloat({param}, {value}) returned {r}")

    # ── String parameters ──────────────────────────────────────────────────────

    def get_string(self, param: str) -> str:
        buf = ctypes.create_string_buffer(512)
        r = self._dll.VBVMR_GetParameterStringA(
            ctypes.c_char_p(param.encode("ascii")),
            buf
        )
        if r != 0:
            return ""
        return buf.value.decode("utf-8", errors="replace")

    def set_string(self, param: str, value: str):
        self._dll.VBVMR_SetParameterStringA(
            ctypes.c_char_p(param.encode("ascii")),
            ctypes.c_char_p(value.encode("ascii"))
        )

    # ── Level meters ───────────────────────────────────────────────────────────

    def get_level(self, level_type: int, channel: int) -> float:
        """
        level_type: 0=pre-fader, 1=post-fader, 2=post-mute, 3=output
        Returns linear amplitude (0.0–1.0+)
        """
        val = ctypes.c_float(0.0)
        r = self._dll.VBVMR_GetLevel(
            ctypes.c_int(level_type),
            ctypes.c_int(channel),
            ctypes.byref(val)
        )
        if r != 0:
            return 0.0
        return float(val.value)

    def get_all_levels(self) -> list:
        """
        Returns a flat list of linear level values:
          [0..15]  = strip channels (8 strips × 2ch L+R), type=2 (post-mute)
          [16..79] = bus channels  (8 buses × 8ch surround), type=3
        We use only L+R (indices 0,1 per bus) for simplicity.
        """
        levels = []
        # Strip levels (post-mute): 8 strips × 2 channels = 16
        for ch in range(16):
            levels.append(self.get_level(2, ch))
        # Bus output levels: 8 buses × 8 channels = 64
        for ch in range(64):
            levels.append(self.get_level(3, ch))
        return levels

    # ── Bulk state ─────────────────────────────────────────────────────────────

    def get_all_params(self) -> dict:
        """Read all relevant strip and bus parameters into a dict."""
        state = {}
        for i in range(STRIP_COUNT):
            for p in STRIP_FLOAT_PARAMS:
                key = f"Strip[{i}].{p}"
                try:
                    state[key] = self.get_float(key)
                except Exception:
                    pass
            for p in STRIP_BOOL_PARAMS:
                key = f"Strip[{i}].{p}"
                try:
                    state[key] = self.get_float(key)
                except Exception:
                    pass
            # Strip label
            try:
                state[f"Strip[{i}].Label"] = self.get_string(f"Strip[{i}].Label")
            except Exception:
                pass

        for i in range(BUS_COUNT):
            for p in BUS_FLOAT_PARAMS:
                key = f"Bus[{i}].{p}"
                try:
                    state[key] = self.get_float(key)
                except Exception:
                    pass
            for p in BUS_BOOL_PARAMS:
                key = f"Bus[{i}].{p}"
                try:
                    state[key] = self.get_float(key)
                except Exception:
                    pass
            try:
                state[f"Bus[{i}].Label"] = self.get_string(f"Bus[{i}].Label")
            except Exception:
                pass

        return state
