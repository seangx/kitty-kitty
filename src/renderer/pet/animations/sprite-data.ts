import type { AnimationState, SkinId } from '@shared/types/pet'

export interface SpriteConfig {
  frames: string[]
  intervalMs: number
}

type SpriteSet = Record<AnimationState, SpriteConfig>

// ─── Classic Cat ───────────────────────────────────────
const classic: SpriteSet = {
  'idle': {
    frames: [
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
      '  /\\_/\\  \n ( -.- ) \n  > ^ <  ',
    ],
    intervalMs: 800,
  },
  'walk-left': {
    frames: [
      '  /\\_/\\  \n ( o.o ) \n =/ ^ \\  ',
      '  /\\_/\\  \n ( o.o ) \n  / ^ \\= ',
    ],
    intervalMs: 400,
  },
  'walk-right': {
    frames: [
      '  /\\_/\\  \n ( o.o ) \n  \\ ^ /= ',
      '  /\\_/\\  \n ( o.o ) \n =\\ ^ /  ',
    ],
    intervalMs: 400,
  },
  'sleep': {
    frames: [
      '  /\\_/\\  \n ( -.- ) zzZ\n  > ^ <  ',
      '  /\\_/\\  \n ( -.- ) zZ \n  > ^ <  ',
      '  /\\_/\\  \n ( -.- ) z  \n  > ^ <  ',
    ],
    intervalMs: 1000,
  },
  'happy': {
    frames: [
      '  /\\_/\\  \n ( ^.^ ) \n  > ^ < \u2661',
      '  /\\_/\\ \u2661\n ( ^.^ ) \n  > ^ <  ',
      ' \u2661/\\_/\\  \n ( ^.^ ) \n  > ^ <  ',
    ],
    intervalMs: 350,
  },
  'think': {
    frames: [
      '  /\\_/\\  \n ( o.o ) .\n  > ^ <  ',
      '  /\\_/\\  \n ( o.o ) ..\n  > ^ <  ',
      '  /\\_/\\  \n ( o.o ) ...\n  > ^ <  ',
    ],
    intervalMs: 500,
  },
  'talk': {
    frames: [
      '  /\\_/\\  \n ( o.o ) \n  > o <  ',
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
      '  /\\_/\\  \n ( o.o ) \n  > \u03c9 <  ',
    ],
    intervalMs: 250,
  },
  'sad': {
    frames: [
      '  /\\_/\\  \n ( T.T ) \n  > ^ <  ',
      '  /\\_/\\  \n ( ;.; ) \n  > ^ <  ',
    ],
    intervalMs: 800,
  },
  'stretch': {
    frames: [
      '  /\\_/\\    \n ( -.o )   \n  />   <   ',
      '  /\\_/\\    \n ( ^.^ )   \n \\>  ~  </ ',
      '  /\\_/\\    \n ( ^.^ )   \n  > ^ <    ',
    ],
    intervalMs: 600,
  },
  'dance': {
    frames: [
      '  /\\_/\\  \n ( ^.^ ) \n </ ^ \\> ',
      ' \u266a/\\_/\\  \n ( ^.^ ) \n  \\^ ^/  ',
      '  /\\_/\\\u266a \n ( ^.^ ) \n </ ^ \\> ',
      '  /\\_/\\  \n ( >.<)  \n  /^ ^\\  ',
    ],
    intervalMs: 280,
  },
  'roll': {
    frames: [
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
      '   __     \n  (o.o )  \n  ~~~~~   ',
      '          \n  (o.o)   \n /\\_/\\   ',
      '     __   \n ( o.o)   \n  ~~~~~   ',
    ],
    intervalMs: 300,
  },
  'lick': {
    frames: [
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
      '  /\\_/\\  \n ( o.o )\\\n  > ^ <  ',
      '  /\\_/\\  \n ( -.- )\\\n  > ^ <  ',
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
    ],
    intervalMs: 400,
  },
  'jump': {
    frames: [
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
      '  /\\_/\\  \n ( ^.^ ) \n         ',
      '  /\\_/\\ !\n ( ^.^ ) \n         ',
      '  /\\_/\\  \n ( o.o ) \n  > ^ <  ',
    ],
    intervalMs: 250,
  },
  'sneak': {
    frames: [
      '  /\\_/\\     \n ( \u00b7.\u00b7 )    \n _/> ^ <\\_  ',
      '   /\\_/\\    \n  ( \u00b7.\u00b7 )   \n __/> ^<\\__ ',
      '    /\\_/\\   \n   ( \u00b7.\u00b7 )  \n ___/>^<\\___ ',
    ],
    intervalMs: 500,
  },
}

// ─── Neko (Kaomoji style) ──────────────────────────────
const neko: SpriteSet = {
  'idle': {
    frames: [
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283 -\u03c9- \u0283  \n  /    \\ \n \u3063    \u3064',
    ],
    intervalMs: 900,
  },
  'walk-left': {
    frames: [
      ' = \u0283\u2022\u0300\u03c9\u2022\u0301\u0283 \n   /  \\  \n  \u3063  \u3064  ',
      '  = \u0283\u2022\u0300\u03c9\u2022\u0301\u0283\n   /  \\  \n   \u3063 \u3064  ',
    ],
    intervalMs: 400,
  },
  'walk-right': {
    frames: [
      ' \u0283\u2022\u0300\u03c9\u2022\u0301\u0283 = \n  /  \\   \n  \u3063  \u3064  ',
      '\u0283\u2022\u0300\u03c9\u2022\u0301\u0283 =  \n  /  \\   \n \u3063  \u3064   ',
    ],
    intervalMs: 400,
  },
  'sleep': {
    frames: [
      '  \u0283 -\u03c9- \u0283 zzZ\n  /    \\    \n \u3063    \u3064   ',
      '  \u0283 -\u03c9- \u0283 zZ \n  /    \\    \n \u3063    \u3064   ',
      '  \u0283 -\u03c9- \u0283 z  \n  /    \\    \n \u3063    \u3064   ',
    ],
    intervalMs: 1000,
  },
  'happy': {
    frames: [
      '  \u0283 \u2267\u03c9\u2266 \u0283 \u2661\n  /    \\  \n \u3063    \u3064 ',
      '\u2661 \u0283 \u2267\u03c9\u2266 \u0283 \n  /    \\  \n \u3063    \u3064 ',
    ],
    intervalMs: 350,
  },
  'think': {
    frames: [
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283 . \n  /    \\  \n \u3063    \u3064 ',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283 ..\n  /    \\  \n \u3063    \u3064 ',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283...\n  /    \\  \n \u3063    \u3064 ',
    ],
    intervalMs: 500,
  },
  'talk': {
    frames: [
      '  \u0283\u2022\u0300o\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283\u2022\u03000\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
    ],
    intervalMs: 250,
  },
  'sad': {
    frames: [
      '  \u0283 T\u03c9T \u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283 ;\u03c9; \u0283  \n  /    \\ \n \u3063    \u3064',
    ],
    intervalMs: 800,
  },
  'stretch': {
    frames: [
      '  \u0283 ~\u03c9~ \u0283   \n  />    <  \n \u3063      \u3064',
      '  \u0283 ^\u03c9^ \u0283   \n \\> ~~ </  \n \u3063      \u3064',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283    \n  /    \\  \n \u3063    \u3064 ',
    ],
    intervalMs: 600,
  },
  'dance': {
    frames: [
      '\u266a \u0283 ^\u03c9^ \u0283 \n  \\  /   \n  \u3063 \u3064   ',
      '  \u0283 ^\u03c9^ \u0283\u266a\n   /  \\  \n  \u3063  \u3064  ',
      '\u266a \u0283 >\u03c9< \u0283 \n  /    \\ \n \u3063    \u3064 ',
    ],
    intervalMs: 280,
  },
  'roll': {
    frames: [
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '   ___    \n  (\u2022\u03c9\u2022)  \n  ~~~~~   ',
      '          \n  (\u2022\u03c9\u2022)  \n  \u0283    \u0283 ',
      '   ___    \n  (\u2022\u03c9\u2022)  \n  ~~~~~   ',
    ],
    intervalMs: 300,
  },
  'lick': {
    frames: [
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283\\ \n  /    \\ \n \u3063    \u3064',
      '  \u0283 -\u03c9- \u0283\\ \n  /    \\ \n \u3063    \u3064',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
    ],
    intervalMs: 400,
  },
  'jump': {
    frames: [
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
      '  \u0283 \u2267\u03c9\u2266 \u0283 \n  /    \\ \n          ',
      '  \u0283 \u2267\u03c9\u2266 \u0283!\n  /    \\ \n          ',
      '  \u0283\u2022\u0300\u03c9\u2022\u0301\u0283  \n  /    \\ \n \u3063    \u3064',
    ],
    intervalMs: 250,
  },
  'sneak': {
    frames: [
      '  \u0283 \u00b7\u03c9\u00b7 \u0283   \n __/  \\__  \n \u3063      \u3064',
      '   \u0283 \u00b7\u03c9\u00b7 \u0283  \n __/ \\___  \n  \u3063     \u3064',
      '    \u0283 \u00b7\u03c9\u00b7 \u0283 \n ___/ \\__ \n   \u3063    \u3064',
    ],
    intervalMs: 500,
  },
}

// ─── Ghost ─────────────────────────────────────────────
const ghost: SpriteSet = {
  'idle': {
    frames: [
      '  ___   \n / o o \\\n | \u2323   |\n  \\~~/  ',
      '  ___   \n / o o \\\n |  \u2323  |\n  \\/\\/  ',
      '  ___   \n / - - \\\n |  \u2323  |\n  \\~~/  ',
    ],
    intervalMs: 900,
  },
  'walk-left': {
    frames: [
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
      '  ___   \n / o o \\\n |  \u2323  |\n  \\/\\/  ',
    ],
    intervalMs: 400,
  },
  'walk-right': {
    frames: [
      '  ___   \n / o o \\\n |  \u2323  |\n  \\/\\/  ',
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
    ],
    intervalMs: 400,
  },
  'sleep': {
    frames: [
      '  ___   \n / - - \\ zzZ\n |  \u2323  |\n  \\~~/  ',
      '  ___   \n / - - \\ zZ \n |  \u2323  |\n  \\~~/  ',
    ],
    intervalMs: 1000,
  },
  'happy': {
    frames: [
      '  ___   \n / ^ ^ \\\n |  \u2323  | \u2661\n  \\~~/  ',
      '  ___  \u2661\n / ^ ^ \\\n |  \u2323  |\n  \\/\\/  ',
    ],
    intervalMs: 350,
  },
  'think': {
    frames: [
      '  ___   \n / o o \\ .\n |  -  |\n  \\~~/  ',
      '  ___   \n / o o \\ ..\n |  -  |\n  \\~~/  ',
      '  ___   \n / o o \\ ...\n |  -  |\n  \\~~/  ',
    ],
    intervalMs: 500,
  },
  'talk': {
    frames: [
      '  ___   \n / o o \\\n |  O  |\n  \\~~/  ',
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
      '  ___   \n / o o \\\n |  o  |\n  \\~~/  ',
    ],
    intervalMs: 250,
  },
  'sad': {
    frames: [
      '  ___   \n / ; ; \\\n |  n  |\n  \\~~/  ',
      '  ___   \n / T T \\\n |  n  |\n  \\/\\/  ',
    ],
    intervalMs: 800,
  },
  'stretch': {
    frames: [
      '   ___   \n  / o o \\\n  |  ~  |\n /\\~~/\\  ',
      '   ___   \n  / ^ ^ \\\n  |  \u2323  |\n  \\~~/   ',
    ],
    intervalMs: 600,
  },
  'dance': {
    frames: [
      ' \u266a___   \n / ^ ^ \\\n |  \u2323  |\n /\\~~/  ',
      '  ___\u266a  \n / ^ ^ \\\n |  \u2323  |\n  \\~~/\\ ',
      '  ___   \n / >.<  \\\n |  \u2323  |\n /\\/\\/ \\',
    ],
    intervalMs: 280,
  },
  'roll': {
    frames: [
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
      '  (o o)  \n  ~~~~~  ',
      '  (o o)  \n  /\\/\\/  ',
      '  (o o)  \n  ~~~~~  ',
    ],
    intervalMs: 300,
  },
  'lick': {
    frames: [
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
      '  ___   \n / o o \\\n |  \u2323  |\\\n  \\~~/  ',
      '  ___   \n / - - \\\n |  \u2323  |\\\n  \\~~/  ',
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
    ],
    intervalMs: 400,
  },
  'jump': {
    frames: [
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
      '  ___   \n / ^ ^ \\\n |  \u2323  |\n        ',
      '  ___ ! \n / ^ ^ \\\n |  \u2323  |\n        ',
      '  ___   \n / o o \\\n |  \u2323  |\n  \\~~/  ',
    ],
    intervalMs: 250,
  },
  'sneak': {
    frames: [
      '  ___      \n / \u00b7 \u00b7 \\   \n |   \u2323 |   \n _\\~~/\\__ ',
      '   ___     \n  / \u00b7 \u00b7 \\  \n  |  \u2323  |  \n __\\~~/__ ',
    ],
    intervalMs: 500,
  },
}

// ─── Robot ─────────────────────────────────────────────
const robot: SpriteSet = {
  'idle': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cb  \u25cb] \n [_\u2584\u2584_] \n  /||\\  ',
    ],
    intervalMs: 900,
  },
  'walk-left': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /|   ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n   |\\  ',
    ],
    intervalMs: 400,
  },
  'walk-right': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n   |\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /|   ',
    ],
    intervalMs: 400,
  },
  'sleep': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u2014  \u2014] zzZ\n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u2014  \u2014] zZ \n [_\u2584\u2584_] \n  /||\\  ',
    ],
    intervalMs: 1000,
  },
  'happy': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf\u0361 \u25cf] \n [_\u25bd_] \u2661\n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584]\u2661\n [\u25cf\u0361 \u25cf] \n [_\u25bd_] \n  /||\\  ',
    ],
    intervalMs: 350,
  },
  'think': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] .\n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] ..\n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf]...\n [_\u2584\u2584_] \n  /||\\  ',
    ],
    intervalMs: 500,
  },
  'talk': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u25a1_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
    ],
    intervalMs: 250,
  },
  'sad': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf_ \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [;  ;] \n [_\u2584\u2584_] \n  /||\\  ',
    ],
    intervalMs: 800,
  },
  'stretch': {
    frames: [
      ' [\u2584\u2584\u2584\u2584]  \n-[\u25cf  \u25cf]-\n [_\u2584\u2584_]  \n  /||\\   ',
      ' [\u2584\u2584\u2584\u2584]  \n [\u25cf  \u25cf] \n [_\u2584\u2584_]  \n  /||\\   ',
    ],
    intervalMs: 600,
  },
  'dance': {
    frames: [
      '\u266a[\u2584\u2584\u2584\u2584] \n [\u25cf\u0361 \u25cf] \n [_\u25bd_] \n  /| \\  ',
      ' [\u2584\u2584\u2584\u2584]\u266a\n [\u25cf\u0361 \u25cf] \n [_\u25bd_] \n  / |\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf\u0361 \u25cf] \n [_\u25bd_] \n \\ |/ \\  ',
    ],
    intervalMs: 280,
  },
  'roll': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
      '  (\u25cf \u25cf) \n  ~~~~~  ',
      '  (\u25cf \u25cf) \n  [\u2584\u2584\u2584] ',
      '  (\u25cf \u25cf) \n  ~~~~~  ',
    ],
    intervalMs: 300,
  },
  'lick': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf]\\\n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cb  \u25cb]\\\n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
    ],
    intervalMs: 400,
  },
  'jump': {
    frames: [
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf\u0361 \u25cf] \n [_\u25bd_] \n        ',
      ' [\u2584\u2584\u2584\u2584]!\n [\u25cf\u0361 \u25cf] \n [_\u25bd_] \n        ',
      ' [\u2584\u2584\u2584\u2584] \n [\u25cf  \u25cf] \n [_\u2584\u2584_] \n  /||\\  ',
    ],
    intervalMs: 250,
  },
  'sneak': {
    frames: [
      ' [\u2584\u2584\u2584\u2584]    \n [\u25cf  \u25cf]   \n_[_\u2584\u2584_]__ ',
      '  [\u2584\u2584\u2584\u2584]   \n  [\u25cf  \u25cf]  \n__[_\u2584\u2584_]_ ',
    ],
    intervalMs: 500,
  },
}

// ─── Bunny ─────────────────────────────────────────────
const bunny: SpriteSet = {
  'idle': {
    frames: [
      ' (\\(\\   \n ( -.-)  \n o_(\")(\") ',
      ' (\\(\\   \n ( -.-)  \n o_(\")(\") ',
      ' (\\(\\   \n ( -.- ) \n o_(\")(\") ',
    ],
    intervalMs: 800,
  },
  'walk-left': {
    frames: [
      ' (\\(\\   \n ( o.o)  \n=o_(\")(\") ',
      ' (\\(\\   \n ( o.o)  \n o_(\")(\")=',
    ],
    intervalMs: 400,
  },
  'walk-right': {
    frames: [
      '  /)/)   \n (o.o )  \n(\")(\")_o= ',
      '  /)/)   \n (o.o )  \n=(\")(\")_o ',
    ],
    intervalMs: 400,
  },
  'sleep': {
    frames: [
      ' (\\(\\    \n ( -.-) zzZ\n o_(\")(\")  ',
      ' (\\(\\    \n ( -.-) zZ \n o_(\")(\")  ',
    ],
    intervalMs: 1000,
  },
  'happy': {
    frames: [
      ' (\\(\\  \u2661\n ( ^.^)  \n o_(\")(\") ',
      ' (\\(\\ \n ( ^.^) \u2661\n o_(\")(\") ',
    ],
    intervalMs: 350,
  },
  'think': {
    frames: [
      ' (\\(\\    \n ( o.o) . \n o_(\")(\") ',
      ' (\\(\\    \n ( o.o) ..\n o_(\")(\") ',
      ' (\\(\\    \n ( o.o)...\n o_(\")(\") ',
    ],
    intervalMs: 500,
  },
  'talk': {
    frames: [
      ' (\\(\\   \n ( o.o)  \n o_(\")(\") ',
      ' (\\(\\   \n ( o.O)  \n o_(\")(\") ',
      ' (\\(\\   \n ( O.o)  \n o_(\")(\") ',
    ],
    intervalMs: 250,
  },
  'sad': {
    frames: [
      ' (\\(\\   \n ( T.T)  \n o_(\")(\") ',
      ' (\\(\\   \n ( ;.;)  \n o_(\")(\") ',
    ],
    intervalMs: 800,
  },
  'stretch': {
    frames: [
      ' (\\(\\     \n ( -.o)   \n o_/(\")(\")\\',
      ' (\\(\\     \n ( ^.^)   \n o_(\")(\")  ',
    ],
    intervalMs: 600,
  },
  'dance': {
    frames: [
      '\u266a(\\(\\   \n ( ^.^)  \n  <(\")(\") ',
      ' (\\(\\\u266a  \n ( ^.^)  \n (\")(\")>  ',
      ' (\\(\\   \n ( >.<)  \n  /(\")(\")\\',
    ],
    intervalMs: 280,
  },
  'roll': {
    frames: [
      ' (\\(\\   \n ( o.o)  \n o_(\")(\") ',
      '  (o.o)  \n  ~~~~~  ',
      '  (o.o)  \n (\\(\\    ',
      '  (o.o)  \n  ~~~~~  ',
    ],
    intervalMs: 300,
  },
  'lick': {
    frames: [
      ' (\\(\\   \n ( o.o)  \n o_(\")(\") ',
      ' (\\(\\   \n ( o.o)\\ \n o_(\")(\") ',
      ' (\\(\\   \n ( -.-)\\  \n o_(\")(\") ',
      ' (\\(\\   \n ( o.o)  \n o_(\")(\") ',
    ],
    intervalMs: 400,
  },
  'jump': {
    frames: [
      ' (\\(\\   \n ( o.o)  \n o_(\")(\") ',
      ' (\\(\\   \n ( ^.^)  \n          ',
      ' (\\(\\ ! \n ( ^.^)  \n          ',
      ' (\\(\\   \n ( o.o)  \n o_(\")(\") ',
    ],
    intervalMs: 250,
  },
  'sneak': {
    frames: [
      ' (\\(\\      \n ( \u00b7.\u00b7)    \n__o_(\")(\")__',
      '  (\\(\\     \n  ( \u00b7.\u00b7)   \n___o_(\")(\")_',
    ],
    intervalMs: 500,
  },
}

// ─── Registry ──────────────────────────────────────────

export const SKINS: Record<SkinId, { name: string; preview: string; sprites: SpriteSet }> = {
  classic: { name: 'Classic', preview: '/\\_/\\\n(o.o)', sprites: classic },
  neko:    { name: 'Neko',    preview: '\u0283\u2022\u0300\u03c9\u2022\u0301\u0283', sprites: neko },
  ghost:   { name: 'Ghost',   preview: ' ___\n/o o\\', sprites: ghost },
  robot:   { name: 'Robot',   preview: '[\u2584\u2584\u2584]\n[\u25cf \u25cf]', sprites: robot },
  bunny:   { name: 'Bunny',   preview: '(\\(\\\n(-.-)' , sprites: bunny },
}

/** Default export: classic sprites (backward compat) */
export const sprites = classic
