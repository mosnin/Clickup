// The app's voice, and the whole catalog of it.
//
// Thirteen patches curated from m1ckc3s/procedural-sounds (MIT — see
// ./audio/THIRD-PARTY-NOTICES.md): every sound is synthesized at play time
// from the parameters below, so there are no sample files, no network
// fetches, and nothing to preload. Gains are the patches' own — the library
// was tuned quiet, and the master multiplier in sound.ts brings the whole
// voice down further rather than any sound up.

import type { Patch } from "./audio/patch";

export const UI_PATCHES = {
  "tap": {
    "source": {
      "type": "sine",
      "frequency": 1300,
      "fm": {
        "ratio": 0.5,
        "depth": 100
      }
    },
    "envelope": {
      "attack": 0,
      "decay": 0.015,
      "sustain": 0,
      "release": 0.005
    },
    "gain": 0.2
  },
  "tick": {
    "source": {
      "type": "sine",
      "frequency": 1400,
      "fm": {
        "ratio": 0.5,
        "depth": 50
      }
    },
    "envelope": {
      "attack": 0,
      "decay": 0.01,
      "sustain": 0,
      "release": 0.004
    },
    "gain": 0.1
  },
  "check_on": {
    "source": {
      "type": "sine",
      "frequency": {
        "start": 250,
        "end": 800
      },
      "fm": {
        "ratio": 0.5,
        "depth": 60
      }
    },
    "envelope": {
      "attack": 0,
      "decay": 0.05,
      "sustain": 0,
      "release": 0.015
    },
    "gain": 0.22
  },
  "toggle_on": {
    "layers": [
      {
        "source": {
          "type": "sine",
          "frequency": 2093
        },
        "envelope": {
          "attack": 0,
          "decay": 0.012,
          "sustain": 0,
          "release": 0.004
        },
        "gain": 0.2
      },
      {
        "source": {
          "type": "sine",
          "frequency": 3136
        },
        "envelope": {
          "attack": 0,
          "decay": 0.012,
          "sustain": 0,
          "release": 0.004
        },
        "delay": 0.025,
        "gain": 0.2
      }
    ]
  },
  "toggle_off": {
    "layers": [
      {
        "source": {
          "type": "sine",
          "frequency": 2219
        },
        "envelope": {
          "attack": 0,
          "decay": 0.012,
          "sustain": 0,
          "release": 0.004
        },
        "gain": 0.2
      },
      {
        "source": {
          "type": "sine",
          "frequency": 2093
        },
        "envelope": {
          "attack": 0,
          "decay": 0.012,
          "sustain": 0,
          "release": 0.004
        },
        "delay": 0.025,
        "gain": 0.2
      }
    ]
  },
  "save": {
    "layers": [
      {
        "source": {
          "type": "sine",
          "frequency": {
            "start": 880,
            "end": 1046
          }
        },
        "envelope": {
          "attack": 0,
          "decay": 0.1,
          "sustain": 0.03,
          "release": 0.04
        },
        "gain": 0.14
      },
      {
        "source": {
          "type": "sine",
          "frequency": {
            "start": 1046,
            "end": 1175
          }
        },
        "envelope": {
          "attack": 0,
          "decay": 0.1,
          "sustain": 0.02,
          "release": 0.04
        },
        "delay": 0.08,
        "gain": 0.1
      }
    ]
  },
  "copy": {
    "layers": [
      {
        "source": {
          "type": "sine",
          "frequency": 1200
        },
        "envelope": {
          "attack": 0,
          "decay": 0.015,
          "sustain": 0,
          "release": 0.006
        },
        "gain": 0.16
      },
      {
        "source": {
          "type": "sine",
          "frequency": 1400
        },
        "envelope": {
          "attack": 0,
          "decay": 0.015,
          "sustain": 0,
          "release": 0.006
        },
        "delay": 0.04,
        "gain": 0.14
      }
    ]
  },
  "success": {
    "layers": [
      {
        "source": {
          "type": "sine",
          "frequency": 523
        },
        "envelope": {
          "attack": 0.003,
          "decay": 0.3,
          "sustain": 0.06,
          "release": 0.1
        },
        "gain": 0.16
      },
      {
        "source": {
          "type": "sine",
          "frequency": 659
        },
        "envelope": {
          "attack": 0.003,
          "decay": 0.28,
          "sustain": 0.05,
          "release": 0.1
        },
        "delay": 0.07,
        "gain": 0.14
      },
      {
        "source": {
          "type": "sine",
          "frequency": {
            "start": 784,
            "end": 880
          }
        },
        "envelope": {
          "attack": 0.003,
          "decay": 0.32,
          "sustain": 0.06,
          "release": 0.12
        },
        "delay": 0.14,
        "gain": 0.15
      }
    ]
  },
  "error": {
    "layers": [
      {
        "source": {
          "type": "sawtooth",
          "frequency": {
            "start": 320,
            "end": 140
          }
        },
        "filter": {
          "type": "lowpass",
          "frequency": 1200
        },
        "envelope": {
          "attack": 0,
          "decay": 0.25,
          "sustain": 0,
          "release": 0.08
        },
        "gain": 0.22
      },
      {
        "source": {
          "type": "square",
          "frequency": {
            "start": 180,
            "end": 80
          }
        },
        "filter": {
          "type": "lowpass",
          "frequency": 800
        },
        "envelope": {
          "attack": 0,
          "decay": 0.2,
          "sustain": 0,
          "release": 0.06
        },
        "delay": 0.03,
        "gain": 0.12
      }
    ]
  },
  "notify": {
    "layers": [
      {
        "source": {
          "type": "sine",
          "frequency": 780,
          "fm": {
            "ratio": 1.5,
            "depth": 150
          }
        },
        "envelope": {
          "attack": 0,
          "decay": 0.4,
          "sustain": 0.04,
          "release": 0.15
        },
        "effects": [
          {
            "type": "reverb",
            "decay": 0.6,
            "damping": 0.6,
            "mix": 0.12
          }
        ],
        "gain": 0.16
      },
      {
        "source": {
          "type": "sine",
          "frequency": 1170,
          "fm": {
            "ratio": 1.5,
            "depth": 120
          }
        },
        "envelope": {
          "attack": 0,
          "decay": 0.35,
          "sustain": 0.03,
          "release": 0.15
        },
        "delay": 0.1,
        "effects": [
          {
            "type": "reverb",
            "decay": 0.6,
            "damping": 0.6,
            "mix": 0.12
          }
        ],
        "gain": 0.14
      }
    ]
  },
  "send": {
    "source": {
      "type": "sine",
      "frequency": {
        "start": 200,
        "end": 700
      },
      "fm": {
        "ratio": 0.5,
        "depth": 80
      }
    },
    "envelope": {
      "attack": 0,
      "decay": 0.06,
      "sustain": 0,
      "release": 0.02
    },
    "gain": 0.25
  },
  "chime": {
    "layers": [
      {
        "source": {
          "type": "sine",
          "frequency": 1046.5
        },
        "envelope": {
          "attack": 0.006,
          "decay": 0.22,
          "sustain": 0,
          "release": 0,
          "curve": "ramp"
        },
        "gain": 0.045,
        "effects": [
          {
            "type": "delay",
            "delay": 0.12,
            "feedback": 0.25,
            "wet": 0.18,
            "lowpass": 4000
          }
        ]
      },
      {
        "source": {
          "type": "sine",
          "frequency": 1332
        },
        "envelope": {
          "attack": 0.006,
          "decay": 0.26,
          "sustain": 0,
          "release": 0,
          "curve": "ramp"
        },
        "gain": 0.02,
        "delay": 0.09,
        "effects": [
          {
            "type": "delay",
            "delay": 0.11,
            "feedback": 0.25,
            "wet": 0.18,
            "lowpass": 4000
          }
        ]
      }
    ]
  },
  "whisper": {
    "source": {
      "type": "noise",
      "color": "white"
    },
    "filter": {
      "type": "lowpass",
      "frequency": 1200,
      "Q": 0.7
    },
    "envelope": {
      "attack": 0.04,
      "decay": 0.16,
      "sustain": 0,
      "release": 0,
      "curve": "ramp"
    },
    "gain": 0.025
  }
} satisfies Record<string, Patch>;

export type UiSoundName = keyof typeof UI_PATCHES;
