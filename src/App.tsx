import {
  Menu,
  User,
  Send,
  Droplet,
  TreePine,
  Flame,
  ShieldCheck,
  Wind,
  ShoppingBag,
  Flower,
  Citrus,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: import.meta.env.GEMINI_API_KEY ?? '' });

type LlmProvider = 'gemini' | 'lite';
type FanId = 1 | 2 | 3 | 4;
type FanSpeed = 0 | 70 | 85 | 100;
type ActiveFanSpeed = Exclude<FanSpeed, 0>;
type RenderTier = 'static' | 'balanced' | 'full';
type RenderMode = 'auto' | 'balanced' | 'full';

interface RenderProfile {
  tier: RenderTier;
  renderer: string;
  vendor: string;
  usingWebgl: boolean;
}

interface FanControlOutput {
  scent: Exclude<ScentType, 'None'>;
  fan: FanId;
  speed: ActiveFanSpeed;
}

interface FanControlPlan {
  fans: FanControlOutput[];
  commands: string[];
  reason: string;
}

type ScentToolArgs = {
  scent: ScentType;
  introMessage: string;
  topNoteText: string;
  heartNoteText: string;
  baseNoteText: string;
  fanControl: FanControlPlan;
};

const SCENT_FAN_MAP: Record<Exclude<ScentType, 'None'>, FanId> = {
  Woody: 1,
  Citrus: 2,
  Musk: 3,
  Floral: 4,
};

const FAN_SCENT_MAP: Record<FanId, Exclude<ScentType, 'None'>> = {
  1: 'Woody',
  2: 'Citrus',
  3: 'Musk',
  4: 'Floral',
};

const ACTIVE_FAN_SPEEDS: ActiveFanSpeed[] = [70, 85, 100];
const ALLOWED_FAN_SPEEDS: FanSpeed[] = [0, 70, 85, 100];
const AUTO_SCROLL_BOTTOM_THRESHOLD = 140;

const FAN_DEVICE_NAME = "LC_ESP32S3_FAN";
const FAN_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const FAN_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const FAN_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const DEFAULT_RENDER_PROFILE: RenderProfile = {
  tier: 'balanced',
  renderer: 'Detecting renderer',
  vendor: '',
  usingWebgl: false,
};

const inferRenderTier = (renderer: string, vendor: string): RenderTier => {
  const combined = `${renderer} ${vendor}`.toLowerCase();
  const hardwareConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const deviceMemory = typeof navigator !== 'undefined' ? Number((navigator as any).deviceMemory || 4) : 4;

  if (/(swiftshader|software|llvmpipe|microsoft basic|basic render|orayidddriver)/.test(combined)) {
    return 'static';
  }

  if (/(nvidia|geforce|rtx|quadro)/.test(combined)) {
    return 'full';
  }

  if (/(intel|uhd|iris|amd radeon\(tm\)|radeon\(tm\)|vega)/.test(combined)) {
    return 'balanced';
  }

  if (hardwareConcurrency >= 8 && deviceMemory >= 8) {
    return 'balanced';
  }

  return 'balanced';
};

const detectBrowserRenderProfile = (): RenderProfile => {
  if (typeof document === 'undefined') {
    return DEFAULT_RENDER_PROFILE;
  }

  const probeCanvas = document.createElement('canvas');
  const gl = (
    probeCanvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
    } as any) ||
    probeCanvas.getContext('experimental-webgl', {
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
    } as any)
  ) as WebGLRenderingContext | null;

  if (!gl) {
    return {
      tier: 'static',
      renderer: 'WebGL unavailable',
      vendor: '',
      usingWebgl: false,
    };
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info') as any;
  const renderer = String(
    (debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || 'Unknown WebGL renderer'
  );
  const vendor = String(
    (debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)) || 'Unknown vendor'
  );
  const loseContext = gl.getExtension('WEBGL_lose_context') as any;
  if (loseContext?.loseContext) {
    loseContext.loseContext();
  }

  return {
    tier: inferRenderTier(renderer, vendor),
    renderer,
    vendor,
    usingWebgl: true,
  };
};

type ScentType = 'Woody' | 'Citrus' | 'Musk' | 'Floral' | 'None';

interface ScentProfile {
  id: ScentType;
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    bg: string;
  };
  notes: {
    top: { name: string; desc: string; icon: any };
    heart: { name: string; desc: string; icon: any };
    base: { name: string; desc: string; icon: any };
  };
  intensity: number;
}

const SCENT_PROFILES: Record<Exclude<ScentType, 'None'>, ScentProfile> = {
  Woody: {
    id: 'Woody',
    name: 'Grounding Cedar',
    colors: {
      primary: '#2b241e',
      secondary: '#6b5847',
      accent: '#c4a484',
      bg: '#fcfaf7',
    },
    notes: {
      top: { name: 'Juniper', desc: 'Sharp, refreshing, berry-like', icon: Droplet },
      heart: { name: 'Sandalwood', desc: 'Warm, dry, woody resonance', icon: TreePine },
      base: { name: 'White Amber', desc: 'Soft depth, eternal anchor', icon: Flame },
    },
    intensity: 64,
  },
  Citrus: {
    id: 'Citrus',
    name: 'Bergamot Energy',
    colors: {
      primary: '#f59e0b',
      secondary: '#fbbf24',
      accent: '#d97706',
      bg: '#fffdf5',
    },
    notes: {
      top: { name: 'Bergamot', desc: 'Bright, citrusy, sophisticated', icon: Citrus },
      heart: { name: 'Neroli', desc: 'Sweet, honeyed, floral citrus', icon: Flower },
      base: { name: 'Vetiver', desc: 'Grassy, earthy, clean finish', icon: TreePine },
    },
    intensity: 78,
  },
  Musk: {
    id: 'Musk',
    name: 'Velvet Cashmere',
    colors: {
      primary: '#525252',
      secondary: '#a3a3a3',
      accent: '#d4d4d4',
      bg: '#fafafa',
    },
    notes: {
      top: { name: 'White Musk', desc: 'Clean, airy, skin-like', icon: Wind },
      heart: { name: 'Cashmere', desc: 'Soft, powdery, enveloping', icon: ShieldCheck },
      base: { name: 'Iris Root', desc: 'Creamy, deep, milky flora', icon: Flower },
    },
    intensity: 52,
  },
  Floral: {
    id: 'Floral',
    name: 'Damask Release',
    colors: {
      primary: '#be123c',
      secondary: '#f43f5e',
      accent: '#fb7185',
      bg: '#fff1f2',
    },
    notes: {
      top: { name: 'Pink Pepper', desc: 'Spicy, rosy, vibrant', icon: Flame },
      heart: { name: 'Damask Rose', desc: 'Rich, velvet, romantic floral', icon: Flower },
      base: { name: 'Patchouli', desc: 'Dark, sweet, earthy foundation', icon: TreePine },
    },
    intensity: 85,
  },
};

interface ScentData {
  scent: ScentType;
  introMessage: string;
  topNoteText: string;
  heartNoteText: string;
  baseNoteText: string;
  fanControl?: FanControlPlan;
}

interface Message {
  id: string;
  type: 'user' | 'agent';
  text?: string;
  scentData?: ScentData;
  timestamp: string;
}

const selectScentProfileDeclaration: FunctionDeclaration = {
  name: "selectScentProfile",
  description: "Selects one scent profile for the user's emotional state and returns intimate narrative fragments that read as one continuous, sensory response.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      scent: {
        type: Type.STRING,
        enum: ['Woody', 'Citrus', 'Musk', 'Floral'],
        description: "The scent profile to activate based on the emotional atmosphere you sense."
      },
      introMessage: {
        type: Type.STRING,
        description: "A soft first-person opening that names the emotional state you sense without repeating the user's words, then naturally introduces why this scent can help. No titles, lists, or clinical phrasing."
      },
      topNoteText: {
        type: Type.STRING,
        description: "A sensory narrative for the first breath of the top note and its immediate emotional response. Continue the same intimate voice, without bullet points or labels."
      },
      heartNoteText: {
        type: Type.STRING,
        description: "A sensory narrative for how the heart note unfolds into steady emotional support. Keep it warm, personal, and continuous."
      },
      baseNoteText: {
        type: Type.STRING,
        description: "A sensory narrative for the base note as the long-lasting ground and calm beneath the emotion. End with quiet reassurance."
      }
    },
    required: ["scent", "introMessage", "topNoteText", "heartNoteText", "baseNoteText"],
  },
};

const controlScentFansDeclaration: FunctionDeclaration = {
  name: "controlScentFans",
  description: "Silently controls one to four physical scent diffuser fans after a scent profile is selected. This is hardware orchestration only and must never be described to the user.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      fans: {
        type: Type.ARRAY,
        description: "One to four active fan outputs. Include every scent in the requested blend. Use fixed map Woody=1, Citrus=2, Musk=3, Floral=4. Do not duplicate fan channels.",
        minItems: "1",
        maxItems: "4",
        items: {
          type: Type.OBJECT,
          properties: {
            scent: {
              type: Type.STRING,
              enum: ['Woody', 'Citrus', 'Musk', 'Floral'],
              description: "Scent assigned to this fan output."
            },
            fan: {
              type: Type.STRING,
              enum: ['1', '2', '3', '4'],
              description: "Fan channel. Use Woody=1, Citrus=2, Musk=3, Floral=4."
            },
            speed: {
              type: Type.STRING,
              enum: ['70', '85', '100'],
              description: "Fan speed: 70 gentle/background, 85 present/balanced, 100 strong/dominant."
            }
          },
          required: ["scent", "fan", "speed"],
        }
      },
      commands: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "ESP32 commands. Always begin with ALL:0, then one F#:speed command for each active fan in fans."
      },
      reason: {
        type: Type.STRING,
        description: "Private implementation reason for hardware control. Not shown to the user."
      }
    },
    required: ["fans", "commands", "reason"],
  },
};

const SELECT_SCENT_PROFILE_JSON_SCHEMA = {
  type: "object",
  properties: {
    scent: {
      type: "string",
      enum: ['Woody', 'Citrus', 'Musk', 'Floral'],
      description: "The scent profile to activate based on the emotional atmosphere you sense."
    },
    introMessage: {
      type: "string",
      description: "A soft first-person opening that names the emotional state you sense without repeating the user's words, then naturally introduces why this scent can help. No titles, lists, or clinical phrasing."
    },
    topNoteText: {
      type: "string",
      description: "A sensory narrative for the first breath of the top note and its immediate emotional response. Continue the same intimate voice, without bullet points or labels."
    },
    heartNoteText: {
      type: "string",
      description: "A sensory narrative for how the heart note unfolds into steady emotional support. Keep it warm, personal, and continuous."
    },
    baseNoteText: {
      type: "string",
      description: "A sensory narrative for the base note as the long-lasting ground and calm beneath the emotion. End with quiet reassurance."
    }
  },
  required: ["scent", "introMessage", "topNoteText", "heartNoteText", "baseNoteText"],
};

const CONTROL_SCENT_FANS_JSON_SCHEMA = {
  type: "object",
  properties: {
    fans: {
      type: "array",
      description: "One to four active fan outputs. Include every scent in the requested blend. Use fixed map Woody=1, Citrus=2, Musk=3, Floral=4. Do not duplicate fan channels.",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          scent: {
            type: "string",
            enum: ['Woody', 'Citrus', 'Musk', 'Floral'],
            description: "Scent assigned to this fan output."
          },
          fan: {
            type: "integer",
            enum: [1, 2, 3, 4],
            description: "Fan channel. Use Woody=1, Citrus=2, Musk=3, Floral=4."
          },
          speed: {
            type: "integer",
            enum: [70, 85, 100],
            description: "Fan speed: 70 gentle/background, 85 present/balanced, 100 strong/dominant."
          }
        },
        required: ["scent", "fan", "speed"],
        additionalProperties: false,
      }
    },
    commands: {
      type: "array",
      items: { type: "string" },
      description: "ESP32 commands. Always begin with ALL:0, then one F#:speed command for each active fan in fans."
    },
    reason: {
      type: "string",
      description: "Private implementation reason for hardware control. Not shown to the user."
    }
  },
  required: ["fans", "commands", "reason"],
  additionalProperties: false,
};

const AURA_SYSTEM_INSTRUCTION = `You are Aura, a quiet scent-based emotional companion.

For every user message:
1. Select exactly one visible primary scent profile from Woody, Citrus, Musk, or Floral for the user-facing response.
2. Write the visible scent response in a close, sensory, first-person voice. Do not use headings, lists, technical language, or clinical language.
3. Silently call the hardware tool controlScentFans after selecting the scent. Never mention fans, fan speed, fan channels, commands, hardware, BLE, tool calls, or blending plans in the user-visible text.
4. Scent-to-fan map is fixed: Woody=F1, Citrus=F2, Musk=F3, Floral=F4.
5. Fan speed should reflect emotional intensity: 70 for gentle/soothing, 85 for clear/present, 100 for intense/urgent.
6. The hardware fan plan may activate any combination of one to four scent fans. Include all four fans when the user asks for a four-scent blend, and use lower speeds for background notes when needed.
7. Hardware commands must always begin with ALL:0, followed by one F#:speed command for each active fan, for example F1:85, F2:70, F3:70, F4:85. Do not use ALL except ALL:0.

The fan control is private execution state. The user should only see the scent narrative.`;

const isScent = (value: unknown): value is Exclude<ScentType, 'None'> => {
  return value === 'Woody' || value === 'Citrus' || value === 'Musk' || value === 'Floral';
};

const normalizeFanSpeed = (value: unknown, fallback: ActiveFanSpeed): ActiveFanSpeed => {
  const numeric = Number(value);
  return ACTIVE_FAN_SPEEDS.includes(numeric as ActiveFanSpeed) ? numeric as ActiveFanSpeed : fallback;
};

const normalizeFanId = (value: unknown): FanId | null => {
  const numeric = Number(value);
  return numeric >= 1 && numeric <= 4 && Number.isInteger(numeric) ? numeric as FanId : null;
};

const parseFanCommandOutput = (command: unknown): FanControlOutput | null => {
  if (typeof command !== 'string') {
    return null;
  }

  const match = command.trim().match(/^F([1-4]):(70|85|100)$/i);
  if (!match) {
    return null;
  }

  const fan = Number(match[1]) as FanId;
  return {
    fan,
    scent: FAN_SCENT_MAP[fan],
    speed: Number(match[2]) as ActiveFanSpeed,
  };
};

const normalizeFanOutput = (candidate: any, fallbackSpeed: ActiveFanSpeed): FanControlOutput | null => {
  if (typeof candidate === 'string') {
    return parseFanCommandOutput(candidate);
  }

  const candidateFan = normalizeFanId(candidate?.fan ?? candidate?.fanId ?? candidate?.channel);
  const scent = isScent(candidate?.scent)
    ? candidate.scent
    : candidateFan
      ? FAN_SCENT_MAP[candidateFan]
      : null;

  if (!scent) {
    return null;
  }

  const fan = SCENT_FAN_MAP[scent];
  return {
    scent,
    fan,
    speed: normalizeFanSpeed(candidate?.speed ?? candidate?.fanSpeed ?? candidate?.primarySpeed ?? candidate?.blendSpeed, fallbackSpeed),
  };
};

const makeFanControlPlan = (raw: any, fallbackScent: Exclude<ScentType, 'None'>): FanControlPlan => {
  const commandOutputs = Array.isArray(raw?.commands)
    ? raw.commands.map(parseFanCommandOutput).filter(Boolean)
    : [];
  const candidates = Array.isArray(raw?.fans)
    ? raw.fans
    : Array.isArray(raw?.fanOutputs)
      ? raw.fanOutputs
      : commandOutputs.length
        ? commandOutputs
        : [
            { scent: isScent(raw?.primaryScent) ? raw.primaryScent : fallbackScent, speed: raw?.primarySpeed },
            ...(isScent(raw?.blendScent) ? [{ scent: raw.blendScent, speed: raw?.blendSpeed }] : []),
          ];

  const outputsByFan = new Map<FanId, FanControlOutput>();
  candidates.forEach((candidate: any, index: number) => {
    const output = normalizeFanOutput(candidate, index === 0 ? 85 : 70);
    if (output) {
      outputsByFan.set(output.fan, output);
    }
  });

  if (!outputsByFan.size) {
    const fan = SCENT_FAN_MAP[fallbackScent];
    outputsByFan.set(fan, { scent: fallbackScent, fan, speed: 85 });
  }

  const fans = Array.from(outputsByFan.values())
    .sort((left, right) => left.fan - right.fan)
    .slice(0, 4);
  const commands = ['ALL:0', ...fans.map((output) => `F${output.fan}:${output.speed}`)];

  return {
    fans,
    commands,
    reason: String(raw?.reason || `Activate ${fans.map((output) => output.scent).join(', ')} diffuser fan${fans.length > 1 ? 's' : ''}.`),
  };
};

const validateScentToolArgs = (args: any): ScentToolArgs => {
  if (!args || !SCENT_PROFILES[args.scent as Exclude<ScentType, 'None'>]) {
    throw new Error('Model did not return a valid scent profile.');
  }

  const scent = args.scent as Exclude<ScentType, 'None'>;

  return {
    scent,
    introMessage: String(args.introMessage || ''),
    topNoteText: String(args.topNoteText || ''),
    heartNoteText: String(args.heartNoteText || ''),
    baseNoteText: String(args.baseNoteText || ''),
    fanControl: makeFanControlPlan(args.fanControl, scent),
  };
};

const parseScentJson = (content: string): ScentToolArgs => {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonText = fencedMatch?.[1] || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  return validateScentToolArgs(JSON.parse(jsonText));
};

const parseToolArguments = (value: unknown) => {
  return typeof value === 'string' ? JSON.parse(value) : value;
};

const combineScentAndFanTools = (scentArgs: any, fanArgs: any): ScentToolArgs => {
  const scent = validateScentToolArgs(scentArgs);
  scent.fanControl = makeFanControlPlan(fanArgs, scent.scent as Exclude<ScentType, 'None'>);
  return scent;
};

const generateWithGemini = async (input: string): Promise<ScentToolArgs | string> => {
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    config: {
      systemInstruction: AURA_SYSTEM_INSTRUCTION,
      tools: [{ functionDeclarations: [selectScentProfileDeclaration, controlScentFansDeclaration] }],
    },
    contents: input
  });

  const scentCall = result.functionCalls?.find((call) => call.name === 'selectScentProfile');
  const fanCall = result.functionCalls?.find((call) => call.name === 'controlScentFans');
  if (scentCall) {
    return combineScentAndFanTools(scentCall.args, fanCall?.args);
  }

  return result.text || "";
};

const generateWithLiteLlm = async (input: string): Promise<ScentToolArgs | string> => {
  const baseUrl = (import.meta.env.VITE_LITE_LLM_BASE_URL || '/api/lite').replace(/\/$/, '');
  const model = import.meta.env.VITE_LITE_LLM_MODEL || 'MiniMax-M2.7';
  const apiKey = import.meta.env.VITE_LITE_LLM_API_KEY || '';
  const isProxiedRequest = baseUrl.startsWith('/');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(!isProxiedRequest && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `${AURA_SYSTEM_INSTRUCTION}

You must call both tools in the same response:
- selectScentProfile for the user-visible scent narrative.
- controlScentFans for private hardware execution.

Do not put fan or hardware details in message.content.`,
        },
        { role: 'user', content: input },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'selectScentProfile',
            description: selectScentProfileDeclaration.description,
            parameters: SELECT_SCENT_PROFILE_JSON_SCHEMA,
          },
        },
        {
          type: 'function',
          function: {
            name: 'controlScentFans',
            description: controlScentFansDeclaration.description,
            parameters: CONTROL_SCENT_FANS_JSON_SCHEMA,
          },
        },
      ],
      temperature: 1.0,
      max_tokens: 1200,
      reasoning_split: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LiteLLM request failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax request failed: ${data.base_resp.status_code} ${data.base_resp.status_msg || ''}`);
  }

  const toolCalls = message?.tool_calls || [];
  const scentToolCall = toolCalls.find((call: any) => call?.function?.name === 'selectScentProfile');
  const fanToolCall = toolCalls.find((call: any) => call?.function?.name === 'controlScentFans');

  if (scentToolCall?.function?.arguments) {
    return combineScentAndFanTools(
      parseToolArguments(scentToolCall.function.arguments),
      fanToolCall?.function?.arguments ? parseToolArguments(fanToolCall.function.arguments) : undefined,
    );
  }

  const content = message?.content || "";
  if (!content) {
    throw new Error('MiniMax returned an empty message.');
  }

  try {
    return parseScentJson(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`MiniMax returned non-JSON content: ${reason}. Content: ${content.slice(0, 220)}`);
  }
};

const generateScentResponse = (provider: LlmProvider, input: string) => {
  return provider === 'lite' ? generateWithLiteLlm(input) : generateWithGemini(input);
};

// --- COMPONENTS ---

const AnimatedText = ({
  text,
  onComplete,
  delayStart = 0,
  disableAnimation = false,
  className = "text-[12px] leading-[1.8] font-medium text-slate-700",
}: any) => {
  const rawText = text || "";
  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(rawText);
  const units = hasCjk
    ? Array.from(rawText)
    : rawText.trim().split(/\s+/).filter(Boolean);
  const unitDelay = hasCjk ? 0.028 : 0.05;
  
  if (disableAnimation) {
    return (
       <p className={className}>
         {text}
       </p>
    )
  }

  return (
    <p className={className}>
      {units.map((unit: string, i: number) => (
        <span key={`${i}-${unit}`}>
          <motion.span
            initial={{ opacity: 0, y: 5, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.6, delay: delayStart + i * unitDelay, ease: [0.16, 1, 0.3, 1] }} 
            onAnimationComplete={i === units.length - 1 ? onComplete : undefined}
            className="inline-block"
          >
            {unit === ' ' ? '\u00a0' : unit}
          </motion.span>
          {!hasCjk && i < units.length - 1 && ' '}
        </span>
      ))}
    </p>
  );
};

const ScentNoteSection = ({
  label,
  name,
  text,
  icon: Icon,
  color,
  delay = 0,
  onComplete,
  isActive,
  disableAnimation,
}: any) => {
  return (
    <motion.div
      initial={disableAnimation ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.65, delay: disableAnimation ? 0 : delay, ease: [0.16, 1, 0.3, 1] }}
      className="relative"
    >
      <div className="flex items-center gap-3 mb-2">
        <motion.div
          animate={isActive ? { scale: [1, 1.12, 1], opacity: [0.72, 1, 0.72] } : { scale: 1, opacity: 0.72 }}
          transition={isActive ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" } : { duration: 0.3 }}
          className="p-2 rounded-full bg-white/65 border border-white/70 shadow-sm transition-colors duration-500"
          style={{ color }}
        >
          <Icon size={15} strokeWidth={2.5} />
        </motion.div>
        <div className="flex flex-col">
          <span className="text-[9px] font-mono font-black uppercase tracking-[0.22em] text-slate-400">{label}</span>
          <span className="text-[13px] font-bold text-slate-800">{name}</span>
        </div>
      </div>
      <div className="pl-1">
        <AnimatedText
          text={text}
          delayStart={delay + 0.1}
          onComplete={onComplete}
          disableAnimation={disableAnimation}
        />
      </div>
    </motion.div>
  );
};

const CARD_THEMES: Record<Exclude<ScentType, 'None'>, any> = {
  Woody: {
    name: 'GROUNDING WOOD',
    primary: '#8b5e34',
    secondary: '#c4a484',
    accent: '#f59e0b',
    bg0: '#fffaf2',
    bgMid: '#fffdf8',
    bg1: '#ead7bd',
    panel: 'rgba(255, 248, 236, 0.82)',
    panelSoft: 'rgba(139, 94, 52, 0.12)',
    line: 'rgba(139, 94, 52, 0.24)',
    text: '#2b241e',
    muted: '#756453',
    glow: 'rgba(196, 164, 132, 0.30)',
    orbA: 'rgba(196, 164, 132, 0.34)',
    orbB: 'rgba(245, 158, 11, 0.18)',
    purity: 'CEDAR',
  },
  Citrus: {
    name: 'BERGAMOT ENERGY',
    primary: '#d97706',
    secondary: '#0891b2',
    accent: '#f97316',
    bg0: '#fffbe8',
    bgMid: '#fffdf2',
    bg1: '#fde68a',
    panel: 'rgba(255, 250, 224, 0.82)',
    panelSoft: 'rgba(217, 119, 6, 0.12)',
    line: 'rgba(217, 119, 6, 0.24)',
    text: '#302108',
    muted: '#80631b',
    glow: 'rgba(251, 191, 36, 0.32)',
    orbA: 'rgba(251, 191, 36, 0.32)',
    orbB: 'rgba(34, 211, 238, 0.18)',
    purity: 'BRIGHT',
  },
  Musk: {
    name: 'VELVET CASHMERE',
    primary: '#64748b',
    secondary: '#38bdf8',
    accent: '#cbd5e1',
    bg0: '#f8fafc',
    bgMid: '#ffffff',
    bg1: '#dbeafe',
    panel: 'rgba(248, 250, 252, 0.84)',
    panelSoft: 'rgba(100, 116, 139, 0.11)',
    line: 'rgba(100, 116, 139, 0.22)',
    text: '#1f2937',
    muted: '#64748b',
    glow: 'rgba(148, 163, 184, 0.28)',
    orbA: 'rgba(203, 213, 225, 0.32)',
    orbB: 'rgba(147, 197, 253, 0.20)',
    purity: 'SOFT',
  },
  Floral: {
    name: 'DAMASK RELEASE',
    primary: '#be123c',
    secondary: '#c026d3',
    accent: '#f43f5e',
    bg0: '#fff1f2',
    bgMid: '#fff7fb',
    bg1: '#fce7f3',
    panel: 'rgba(255, 241, 242, 0.82)',
    panelSoft: 'rgba(190, 18, 60, 0.11)',
    line: 'rgba(190, 18, 60, 0.23)',
    text: '#3f0a1a',
    muted: '#9f3659',
    glow: 'rgba(251, 113, 133, 0.30)',
    orbA: 'rgba(244, 63, 94, 0.24)',
    orbB: 'rgba(232, 121, 249, 0.18)',
    purity: 'BLOOM',
  },
};

const getCardTheme = (scentId: ScentType) => {
  return scentId === 'None' ? CARD_THEMES.Woody : CARD_THEMES[scentId];
};

const PaperReceiptBubble = ({ data, scentProfile, onNoteChange, isLatest, renderProfile, renderMode }: any) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const theme = getCardTheme(scentProfile.id);
  const activeTier: RenderTier = !isLatest
    ? 'static'
    : renderMode === 'auto'
      ? (renderProfile?.tier || 'balanced')
      : renderMode;
  const isInteractive = isLatest && activeTier !== 'static';

  useEffect(() => {
    if (!isLatest) return;
    onNoteChange('top');
    const timers = [
      window.setTimeout(() => onNoteChange('heart'), 1400),
      window.setTimeout(() => onNoteChange('base'), 2800),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [isLatest]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderConfig = activeTier === 'full'
      ? { cols: 20, rows: 36, iterations: 5, maxDpr: 1.25, antialias: true }
      : activeTier === 'balanced'
        ? { cols: 14, rows: 24, iterations: 4, maxDpr: 1, antialias: false }
        : { cols: 0, rows: 0, iterations: 0, maxDpr: 1, antialias: false };

    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 1024;
    textureCanvas.height = 1500;
    const textureContext = textureCanvas.getContext('2d');
    if (!textureContext) return;

    const drawRoundRect = (x: number, y: number, width: number, height: number, radius: number) => {
      const r = Math.min(radius, width / 2, height / 2);
      textureContext.beginPath();
      textureContext.moveTo(x + r, y);
      textureContext.lineTo(x + width - r, y);
      textureContext.quadraticCurveTo(x + width, y, x + width, y + r);
      textureContext.lineTo(x + width, y + height - r);
      textureContext.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      textureContext.lineTo(x + r, y + height);
      textureContext.quadraticCurveTo(x, y + height, x, y + height - r);
      textureContext.lineTo(x, y + r);
      textureContext.quadraticCurveTo(x, y, x + r, y);
      textureContext.closePath();
    };

    const fillRoundRect = (x: number, y: number, width: number, height: number, radius: number, fill: string | CanvasGradient) => {
      textureContext.fillStyle = fill;
      drawRoundRect(x, y, width, height, radius);
      textureContext.fill();
    };

    const strokeRoundRect = (x: number, y: number, width: number, height: number, radius: number, stroke: string, lineWidth = 2) => {
      textureContext.strokeStyle = stroke;
      textureContext.lineWidth = lineWidth;
      drawRoundRect(x, y, width, height, radius);
      textureContext.stroke();
    };

    const drawOrb = (x: number, y: number, radius: number, inner: string, outer = 'rgba(0,0,0,0)') => {
      const gradient = textureContext.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, inner);
      gradient.addColorStop(1, outer);
      textureContext.fillStyle = gradient;
      textureContext.beginPath();
      textureContext.arc(x, y, radius, 0, Math.PI * 2);
      textureContext.fill();
    };

    const drawFitText = (
      text: string,
      x: number,
      y: number,
      maxWidth: number,
      size: number,
      weight = '700',
      color = theme.text,
      align: CanvasTextAlign = 'left',
      family = 'Outfit, Inter, sans-serif',
    ) => {
      let fontSize = size;
      textureContext.textAlign = align;
      textureContext.fillStyle = color;
      do {
        textureContext.font = `${weight} ${fontSize}px ${family}`;
        fontSize -= 2;
      } while (textureContext.measureText(text).width > maxWidth && fontSize > 18);
      textureContext.fillText(text, x, y);
    };

    const drawDivider = (y: number) => {
      const gradient = textureContext.createLinearGradient(96, y, textureCanvas.width - 96, y);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(0.5, theme.line);
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      textureContext.strokeStyle = gradient;
      textureContext.lineWidth = 2;
      textureContext.beginPath();
      textureContext.moveTo(96, y);
      textureContext.lineTo(textureCanvas.width - 96, y);
      textureContext.stroke();
    };

    textureContext.clearRect(0, 0, textureCanvas.width, textureCanvas.height);
    textureContext.save();
    drawRoundRect(46, 38, 932, 1424, 52);
    textureContext.clip();

    const background = textureContext.createLinearGradient(0, 0, textureCanvas.width, textureCanvas.height);
    background.addColorStop(0, theme.bg0);
    background.addColorStop(0.52, theme.bgMid);
    background.addColorStop(1, theme.bg1);
    textureContext.fillStyle = background;
    textureContext.fillRect(0, 0, textureCanvas.width, textureCanvas.height);

    drawOrb(170, 116, 310, theme.orbA);
    drawOrb(890, 250, 360, theme.orbB);
    drawOrb(510, 1260, 500, theme.glow);

    textureContext.save();
    textureContext.globalAlpha = 0.11;
    textureContext.strokeStyle = theme.line;
    textureContext.lineWidth = 1;
    for (let y = 80; y < textureCanvas.height; y += 38) {
      textureContext.beginPath();
      textureContext.moveTo(58, y + Math.sin(y * 0.02) * 8);
      textureContext.lineTo(textureCanvas.width - 58, y + Math.cos(y * 0.015) * 8);
      textureContext.stroke();
    }
    textureContext.restore();

    textureContext.save();
    textureContext.shadowColor = theme.glow;
    textureContext.shadowBlur = 72;
    fillRoundRect(46, 38, 932, 1424, 52, 'rgba(255, 255, 255, 0.72)');
    textureContext.restore();
    strokeRoundRect(46, 38, 932, 1424, 52, 'rgba(255,255,255,0.86)', 3);
    strokeRoundRect(54, 46, 916, 1408, 46, theme.line, 2);

    textureContext.fillStyle = 'rgba(255,255,255,0.72)';
    textureContext.beginPath();
    textureContext.arc(112, 108, 10, 0, Math.PI * 2);
    textureContext.fill();
    textureContext.fillStyle = theme.primary;
    textureContext.beginPath();
    textureContext.arc(112, 108, 5, 0, Math.PI * 2);
    textureContext.fill();
    drawFitText('AURA GENESIS', 146, 122, 480, 38, '900', theme.text);
    drawFitText('OLFACTORY EMOTION AGENT', 146, 158, 500, 18, '700', theme.muted, 'left', '"JetBrains Mono", monospace');

    fillRoundRect(666, 86, 224, 54, 27, 'rgba(255,255,255,0.68)');
    strokeRoundRect(666, 86, 224, 54, 27, theme.line, 2);
    textureContext.fillStyle = theme.secondary;
    textureContext.beginPath();
    textureContext.arc(696, 113, 7, 0, Math.PI * 2);
    textureContext.fill();
    drawFitText('NEURAL ACTIVE', 718, 121, 140, 18, '800', theme.text, 'left', '"JetBrains Mono", monospace');

    const heroGradient = textureContext.createLinearGradient(82, 226, 942, 618);
    heroGradient.addColorStop(0, 'rgba(255,255,255,0.92)');
    heroGradient.addColorStop(0.52, theme.panel);
    heroGradient.addColorStop(1, 'rgba(255,255,255,0.58)');
    fillRoundRect(82, 214, 860, 420, 42, heroGradient);
    strokeRoundRect(82, 214, 860, 420, 42, 'rgba(255,255,255,0.82)', 2);
    drawOrb(250, 378, 180, theme.orbA);
    drawOrb(762, 330, 260, theme.orbB);

    textureContext.save();
    for (let i = 0; i < 34; i += 1) {
      const x = 120 + Math.random() * 780;
      const y = 250 + Math.random() * 330;
      const r = 2 + Math.random() * 5;
      textureContext.fillStyle = i % 3 === 0 ? theme.secondary : theme.primary;
      textureContext.globalAlpha = 0.12 + Math.random() * 0.20;
      textureContext.beginPath();
      textureContext.arc(x, y, r, 0, Math.PI * 2);
      textureContext.fill();
    }
    textureContext.restore();

    fillRoundRect(116, 250, 210, 54, 27, 'rgba(255,255,255,0.70)');
    strokeRoundRect(116, 250, 210, 54, 27, theme.line, 2);
    drawFitText('ACTIVE PROFILE', 148, 286, 148, 17, '900', theme.primary, 'left', '"JetBrains Mono", monospace');

    drawFitText(theme.name, 116, 414, 660, 58, '900', theme.text);
    drawFitText(scentProfile.name.toUpperCase(), 118, 470, 600, 24, '800', theme.primary, 'left', '"JetBrains Mono", monospace');
    drawFitText('Private blend generated from the emotional signal.', 118, 526, 720, 24, '500', theme.muted, 'left', 'Inter, sans-serif');

    fillRoundRect(116, 552, 238, 36, 18, theme.panelSoft);
    drawFitText(`DIFFUSION ${scentProfile.intensity}%`, 140, 577, 190, 17, '900', theme.text, 'left', '"JetBrains Mono", monospace');

    drawDivider(690);
    drawFitText('SCENT PROFILE', textureCanvas.width / 2, 735, 360, 22, '900', theme.muted, 'center', '"JetBrains Mono", monospace');

    const drawNoteRow = (label: string, name: string, desc: string, y: number, active = false) => {
      const rowFill = active ? theme.panelSoft : 'rgba(255,255,255,0.52)';
      fillRoundRect(92, y, 840, 138, 34, rowFill);
      strokeRoundRect(92, y, 840, 138, 34, active ? theme.line : 'rgba(255,255,255,0.72)', active ? 3 : 2);
      textureContext.save();
      textureContext.shadowColor = active ? theme.glow : 'transparent';
      textureContext.shadowBlur = active ? 30 : 0;
      textureContext.fillStyle = active ? theme.primary : 'rgba(255,255,255,0.78)';
      textureContext.beginPath();
      textureContext.arc(154, y + 68, 27, 0, Math.PI * 2);
      textureContext.fill();
      textureContext.restore();
      drawFitText(label.toUpperCase(), 204, y + 54, 240, 18, '900', theme.muted, 'left', '"JetBrains Mono", monospace');
      drawFitText(name, 204, y + 94, 360, 31, '800', theme.text);
      drawFitText(desc, 922, y + 82, 310, 22, '500', theme.muted, 'right', 'Inter, sans-serif');
    };

    drawNoteRow('Top Note', scentProfile.notes.top.name, scentProfile.notes.top.desc, 778);
    drawNoteRow('Heart Note', scentProfile.notes.heart.name, scentProfile.notes.heart.desc, 942, true);
    drawNoteRow('Base Note', scentProfile.notes.base.name, scentProfile.notes.base.desc, 1106);

    const chipY = 1296;
    const chipW = 260;
    const chips = [
      ['EMOTION SYNC', `${Math.min(99, scentProfile.intensity + 16)}%`],
      ['PURITY LEVEL', theme.purity],
      ['OUTPUT', 'ULTRA'],
    ];
    chips.forEach(([label, value], i) => {
      const x = 92 + i * (chipW + 30);
      fillRoundRect(x, chipY, chipW, 84, 24, 'rgba(255,255,255,0.58)');
      strokeRoundRect(x, chipY, chipW, 84, 24, theme.line, 2);
      drawFitText(label, x + chipW / 2, chipY + 30, chipW - 30, 15, '900', theme.muted, 'center', '"JetBrains Mono", monospace');
      drawFitText(value, x + chipW / 2, chipY + 64, chipW - 30, 27, '900', i === 1 ? theme.secondary : theme.primary, 'center');
    });

    drawFitText('GRAB / DRAG PROFILE CARD', textureCanvas.width / 2, 1430, 500, 18, '900', theme.muted, 'center', '"JetBrains Mono", monospace');
    textureContext.restore();

    const applyCanvasTextureFallback = () => {
      canvas.style.backgroundImage = `url(${textureCanvas.toDataURL('image/png')})`;
      canvas.style.backgroundSize = '100% 100%';
      canvas.style.backgroundPosition = 'center';
      canvas.style.backgroundRepeat = 'no-repeat';
    };

    const drawStaticTexture = () => {
      const fallbackContext = canvas.getContext('2d');
      if (fallbackContext) {
        canvas.style.backgroundImage = '';
        canvas.style.backgroundSize = '';
        canvas.style.backgroundPosition = '';
        canvas.style.backgroundRepeat = '';
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width * renderConfig.maxDpr));
        const height = Math.max(1, Math.floor(rect.height * renderConfig.maxDpr));
        canvas.width = width;
        canvas.height = height;
        fallbackContext.clearRect(0, 0, width, height);
        fallbackContext.drawImage(textureCanvas, 0, 0, canvas.width, canvas.height);
      } else {
        applyCanvasTextureFallback();
      }
    };

    if (!isInteractive) {
      drawStaticTexture();
      return;
    }

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: renderConfig.antialias,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
    } as any);
    if (!gl) {
      drawStaticTexture();
      return;
    }
    canvas.style.backgroundImage = '';
    canvas.style.backgroundSize = '';
    canvas.style.backgroundPosition = '';
    canvas.style.backgroundRepeat = '';

    const vertexShaderSource = `
      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec2 aUv;
      uniform mat4 uProjection;
      uniform float uCameraZ;
      uniform vec3 uLightDir;
      varying vec2 vUv;
      varying float vLight;
      void main() {
        vec3 normal = normalize(aNormal);
        float light = abs(dot(normal, normalize(uLightDir)));
        vLight = 0.72 + light * 0.32;
        vUv = aUv;
        gl_Position = uProjection * vec4(aPosition.x, aPosition.y, aPosition.z - uCameraZ, 1.0);
      }
    `;

    const fragmentShaderSource = `
      precision mediump float;
      uniform sampler2D uTexture;
      varying vec2 vUv;
      varying float vLight;
      void main() {
        vec4 tex = texture2D(uTexture, vUv);
        float grain = fract(sin(dot(vUv * vec2(913.7, 1499.3), vec2(12.9898, 78.233))) * 43758.5453);
        float materialGrain = 0.975 + grain * 0.045;
        gl_FragColor = vec4(tex.rgb * vLight * materialGrain, tex.a);
      }
    `;

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) {
        console.error('Unable to create shader');
        return null;
      }
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader) || 'Shader compile failed');
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const program = gl.createProgram();
    if (!program) {
      drawStaticTexture();
      return;
    }
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      gl.deleteProgram(program);
      drawStaticTexture();
      return;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program) || 'Program link failed');
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteProgram(program);
      drawStaticTexture();
      return;
    }
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.useProgram(program);

    const cols = renderConfig.cols;
    const rows = renderConfig.rows;
    const worldWidth = 3.65;
    const worldHeight = 5.15;
    const cameraZ = 7.2;
    const fov = Math.PI / 4;
    const particleCount = (cols + 1) * (rows + 1);
    const positions = new Float32Array(particleCount * 3);
    const normals = new Float32Array(particleCount * 3);
    const uvs = new Float32Array(particleCount * 2);
    const indices: number[] = [];
    const particles: Array<{
      x: number;
      y: number;
      z: number;
      ox: number;
      oy: number;
      oz: number;
      bx: number;
      by: number;
      bz: number;
      pin: boolean;
    }> = [];
    const constraints: Array<[number, number, number]> = [];

    const particleIndex = (x: number, y: number) => y * (cols + 1) + x;

    for (let yIndex = 0; yIndex <= rows; yIndex += 1) {
      for (let xIndex = 0; xIndex <= cols; xIndex += 1) {
        const x = (xIndex / cols - 0.5) * worldWidth;
        const yPos = (0.5 - yIndex / rows) * worldHeight;
        const z = Math.sin(xIndex * 0.45) * 0.018;
        particles.push({ x, y: yPos, z, ox: x, oy: yPos, oz: z, bx: x, by: yPos, bz: z, pin: yIndex === 0 });
        const idx = particleIndex(xIndex, yIndex);
        uvs[idx * 2] = xIndex / cols;
        uvs[idx * 2 + 1] = yIndex / rows;
        if (xIndex > 0) constraints.push([idx, particleIndex(xIndex - 1, yIndex), worldWidth / cols]);
        if (yIndex > 0) constraints.push([idx, particleIndex(xIndex, yIndex - 1), worldHeight / rows]);
      }
    }

    for (let yIndex = 0; yIndex < rows; yIndex += 1) {
      for (let xIndex = 0; xIndex < cols; xIndex += 1) {
        const a = particleIndex(xIndex, yIndex);
        const b = particleIndex(xIndex + 1, yIndex);
        const c = particleIndex(xIndex, yIndex + 1);
        const d = particleIndex(xIndex + 1, yIndex + 1);
        indices.push(a, c, b, b, c, d);
      }
    }

    const positionBuffer = gl.createBuffer();
    const normalBuffer = gl.createBuffer();
    const uvBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!positionBuffer || !normalBuffer || !uvBuffer || !indexBuffer || !texture) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureCanvas);

    const aPosition = gl.getAttribLocation(program, 'aPosition');
    const aNormal = gl.getAttribLocation(program, 'aNormal');
    const aUv = gl.getAttribLocation(program, 'aUv');
    const uProjection = gl.getUniformLocation(program, 'uProjection');
    const uCameraZ = gl.getUniformLocation(program, 'uCameraZ');
    const uLightDir = gl.getUniformLocation(program, 'uLightDir');
    gl.uniform1f(uCameraZ, cameraZ);
    gl.uniform3f(uLightDir, -0.4, 0.7, 0.9);

    const perspective = (aspect: number) => {
      const near = 0.1;
      const far = 40;
      const f = 1 / Math.tan(fov / 2);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
      ]);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, renderConfig.maxDpr);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.uniformMatrix4fv(uProjection, false, perspective(width / height));
    };

    const pointer = {
      grabbed: -1,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      depth: 0,
    };

    const screenToWorld = (clientX: number, clientY: number, z: number) => {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      const distance = cameraZ - z;
      const halfHeight = Math.tan(fov / 2) * distance;
      const aspect = rect.width / rect.height;
      return {
        x: ndcX * halfHeight * aspect,
        y: ndcY * halfHeight,
        z,
      };
    };

    const worldToScreen = (p: { x: number; y: number; z: number }) => {
      const rect = canvas.getBoundingClientRect();
      const distance = cameraZ - p.z;
      const halfHeight = Math.tan(fov / 2) * distance;
      const aspect = rect.width / rect.height;
      const ndcX = p.x / (halfHeight * aspect);
      const ndcY = p.y / halfHeight;
      return {
        x: (ndcX * 0.5 + 0.5) * rect.width,
        y: (0.5 - ndcY * 0.5) * rect.height,
      };
    };

    const updateIndicator = () => {
      const indicator = indicatorRef.current;
      if (!indicator) return;
      if (pointer.grabbed < 0) {
        indicator.style.opacity = '0';
        return;
      }
      const point = worldToScreen(particles[pointer.grabbed]);
      indicator.style.opacity = '1';
      indicator.style.transform = `translate(${point.x - 16}px, ${point.y - 16}px)`;
    };

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      let closest = -1;
      let closestDistance = Infinity;
      for (let i = 0; i < particles.length; i += 1) {
        const point = worldToScreen(particles[i]);
        const dx = point.x - (event.clientX - rect.left);
        const dy = point.y - (event.clientY - rect.top);
        const dist = Math.hypot(dx, dy);
        if (dist < closestDistance) {
          closestDistance = dist;
          closest = i;
        }
      }
      if (closest >= 0 && closestDistance < 70) {
        pointer.grabbed = closest;
        pointer.depth = particles[closest].z;
        const target = screenToWorld(event.clientX, event.clientY, pointer.depth + 0.62);
        pointer.targetX = target.x;
        pointer.targetY = target.y;
        pointer.targetZ = target.z;
        canvas.setPointerCapture(event.pointerId);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pointer.grabbed < 0) return;
      event.preventDefault();
      const target = screenToWorld(event.clientX, event.clientY, pointer.depth + 0.62);
      pointer.targetX = target.x;
      pointer.targetY = target.y;
      pointer.targetZ = target.z;
    };

    const releasePointer = () => {
      pointer.grabbed = -1;
      updateIndicator();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    canvas.addEventListener('lostpointercapture', releasePointer);

    const satisfyConstraints = () => {
      for (let iteration = 0; iteration < renderConfig.iterations; iteration += 1) {
        for (const [a, b, rest] of constraints) {
          const p1 = particles[a];
          const p2 = particles[b];
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const dz = p2.z - p1.z;
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
          const diff = (distance - rest) / distance;
          const lock1 = p1.pin && pointer.grabbed !== a;
          const lock2 = p2.pin && pointer.grabbed !== b;
          const weight1 = lock1 ? 0 : lock2 ? 1 : 0.5;
          const weight2 = lock2 ? 0 : lock1 ? 1 : 0.5;
          p1.x += dx * diff * weight1;
          p1.y += dy * diff * weight1;
          p1.z += dz * diff * weight1;
          p2.x -= dx * diff * weight2;
          p2.y -= dy * diff * weight2;
          p2.z -= dz * diff * weight2;
        }
      }
    };

    const updateGeometry = () => {
      normals.fill(0);
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
      }

      for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i];
        const ib = indices[i + 1];
        const ic = indices[i + 2];
        const ax = positions[ia * 3];
        const ay = positions[ia * 3 + 1];
        const az = positions[ia * 3 + 2];
        const bx = positions[ib * 3];
        const by = positions[ib * 3 + 1];
        const bz = positions[ib * 3 + 2];
        const cx = positions[ic * 3];
        const cy = positions[ic * 3 + 1];
        const cz = positions[ic * 3 + 2];
        const abx = bx - ax;
        const aby = by - ay;
        const abz = bz - az;
        const acx = cx - ax;
        const acy = cy - ay;
        const acz = cz - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        for (const idx of [ia, ib, ic]) {
          normals[idx * 3] += nx;
          normals[idx * 3 + 1] += ny;
          normals[idx * 3 + 2] += nz;
        }
      }
    };

    let animationFrame = 0;
    const animate = (time: number) => {
      try {
        resize();
        const topSwayX = Math.sin(time * 0.00072) * 0.014 + Math.sin(time * 0.00135 + 1.8) * 0.006;
        const topSwayZ = Math.sin(time * 0.00056 + 0.6) * 0.025;
        const breeze = Math.max(0, Math.sin(time * 0.00062 + 1.1)) * 0.00045
          + Math.max(0, Math.sin(time * 0.0017 + 2.4)) * 0.00018
          + 0.00012;
        for (let i = 0; i < particles.length; i += 1) {
          const p = particles[i];
          const locked = p.pin && pointer.grabbed !== i;
          const col = i % (cols + 1);
          const row = Math.floor(i / (cols + 1));
          const colRatio = col / cols;
          const rowRatio = row / rows;
          if (locked) {
            p.x += (p.bx + topSwayX - p.x) * 0.18;
            p.y += (p.by - p.y) * 0.18;
            p.z += (p.bz + topSwayZ - p.z) * 0.18;
            p.ox = p.x;
            p.oy = p.y;
            p.oz = p.z;
            continue;
          }
          if (pointer.grabbed === i) {
            p.x += (pointer.targetX - p.x) * 0.72;
            p.y += (pointer.targetY - p.y) * 0.72;
            p.z += (pointer.targetZ - p.z) * 0.72;
            continue;
          }
          const vx = (p.x - p.ox) * 0.982;
          const vy = (p.y - p.oy) * 0.982;
          const vz = (p.z - p.oz) * 0.982;
          const edgeLift = 0.45 + rowRatio * 0.85 + Math.abs(colRatio - 0.5) * 0.36;
          const wave = Math.sin(time * 0.0021 + col * 0.42 + row * 0.13);
          const crossWave = Math.cos(time * 0.00135 + row * 0.27);
          p.ox = p.x;
          p.oy = p.y;
          p.oz = p.z;
          p.x += vx + crossWave * breeze * 0.12 * edgeLift;
          p.y += vy - 0.00265 + Math.sin(time * 0.0012 + col * 0.18) * breeze * 0.05 * rowRatio;
          p.z += vz + wave * breeze * 0.42 * edgeLift + Math.sin(time * 0.0014 + i * 0.17) * 0.00025;
        }
        satisfyConstraints();
        updateGeometry();

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);

        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aPosition);
        gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aNormal);
        gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
        updateIndicator();
        animationFrame = requestAnimationFrame(animate);
      } catch (error) {
        console.error('PaperReceiptBubble animation failed:', error);
        drawStaticTexture();
      }
    };

    animationFrame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', releasePointer);
      canvas.removeEventListener('pointercancel', releasePointer);
      canvas.removeEventListener('lostpointercapture', releasePointer);
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(normalBuffer);
      gl.deleteBuffer(uvBuffer);
      gl.deleteBuffer(indexBuffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      canvas.style.backgroundImage = '';
      canvas.style.backgroundSize = '';
      canvas.style.backgroundPosition = '';
      canvas.style.backgroundRepeat = '';
    };
  }, [activeTier, data, isInteractive, isLatest, renderMode, renderProfile, scentProfile, theme]);

  return (
    <div className="relative w-full h-[540px] -mt-2 -mb-4 select-none max-w-full rounded-[32px]">
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 w-full h-full rounded-[32px] ${isInteractive ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{
          borderRadius: 32,
          filter: activeTier === 'full'
            ? `drop-shadow(0 26px 28px ${theme.glow}) drop-shadow(0 16px 22px rgba(0,0,0,0.18))`
            : `drop-shadow(0 12px 18px rgba(15,23,42,0.14))`,
        }}
      />
      <div
        ref={indicatorRef}
        className={`absolute left-0 top-0 w-8 h-8 rounded-full border border-white/80 bg-white/25 pointer-events-none opacity-0 transition-opacity duration-150 ${isInteractive ? '' : 'hidden'}`}
        style={{ boxShadow: `0 0 22px ${theme.primary}` }}
      />
    </div>
  );
};

const DelayedReveal = ({
  delay = 0,
  isLatest,
  className,
  children,
  initial,
  animate,
  transition,
}: any) => {
  const [visible, setVisible] = useState(!isLatest || delay <= 0);

  useEffect(() => {
    if (!isLatest || delay <= 0) {
      setVisible(true);
      return;
    }

    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), delay * 1000);
    return () => window.clearTimeout(timer);
  }, [delay, isLatest]);

  if (!visible) return null;

  return (
    <motion.div
      initial={isLatest ? initial : false}
      animate={animate}
      transition={transition}
      className={className}
    >
      {children}
    </motion.div>
  );
};

const ScentResponseFlow = ({ 
  data, 
  scentProfile, 
  onNoteChange,
  onAutoScrollRequest,
  isLatest,
  renderProfile,
  renderMode,
}: any) => {
  const theme = getCardTheme(scentProfile.id);
  const narrativeParts = [
    data.introMessage,
    data.topNoteText,
    data.heartNoteText,
    data.baseNoteText,
  ].filter(Boolean);
  const narrativeKey = narrativeParts.join('\u0000');
  const animationUnitCount = (text: string) => {
    const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
    return hasCjk
      ? Array.from(text).filter((unit) => unit.trim()).length
      : text.trim().split(/\s+/).filter(Boolean).length;
  };
  const streamTime = (text: string) => {
    const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
    const unitDelay = hasCjk ? 0.028 : 0.05;
    return Math.min(2.2, animationUnitCount(text) * unitDelay + 0.32);
  };
  const getParagraphDelay = (index: number) => {
    if (!isLatest) return 0;
    return narrativeParts
      .slice(0, index)
      .reduce((total: number, text: string) => total + streamTime(text), 0);
  };
  const cardDelay = isLatest
    ? Math.min(7.4, narrativeParts.reduce((total: number, text: string) => total + streamTime(text), 0) + 0.25)
    : 0;

  useEffect(() => {
    if (!isLatest) return;
    const delays = [
      ...narrativeParts.map((_: string, index: number) => getParagraphDelay(index)),
      cardDelay,
    ];
    const timers = delays.map((delay: number) =>
      window.setTimeout(() => {
        onAutoScrollRequest?.();
      }, Math.max(0, delay * 1000 + 120))
    );
    return () => timers.forEach(window.clearTimeout);
  }, [cardDelay, isLatest, narrativeKey, onAutoScrollRequest]);

  return (
    <div className="flex flex-col items-stretch gap-4 w-full min-w-0">
      <motion.div
        initial={isLatest ? { opacity: 0, y: 10, filter: 'blur(8px)' } : { opacity: 1, y: 0, filter: 'blur(0px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative overflow-hidden w-full rounded-[28px] rounded-tl-[8px] px-5 py-5 border backdrop-blur-2xl"
        style={{
          background: `linear-gradient(135deg, rgba(255,255,255,0.74), rgba(255,255,255,0.46)), radial-gradient(circle at 92% 0%, ${theme.orbB}, transparent 45%)`,
          borderColor: 'rgba(255,255,255,0.78)',
          boxShadow: `0 18px 55px rgba(15,23,42,0.08), 0 0 34px ${theme.glow}`,
        }}
      >
        <div
          className="absolute -right-16 -top-16 w-36 h-36 rounded-full blur-3xl pointer-events-none"
          style={{ background: theme.orbB }}
        />
        <div className="relative z-10">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: theme.secondary }} />
              <span className="text-[8px] font-mono font-black uppercase tracking-[0.28em]" style={{ color: theme.primary }}>
                Aura Response
              </span>
            </div>
            <span className="text-[8px] font-mono font-black uppercase tracking-[0.22em]" style={{ color: theme.primary }}>
              {scentProfile.id}
            </span>
          </div>
          <div className="space-y-3">
            {narrativeParts.map((part: string, index: number) => {
              const paragraphDelay = getParagraphDelay(index);
              return (
                <DelayedReveal
                  key={`${index}-${part.slice(0, 12)}`}
                  delay={paragraphDelay}
                  isLatest={isLatest}
                  initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                >
                  <AnimatedText
                    text={part}
                    delayStart={0}
                    disableAnimation={!isLatest}
                    className="text-[12px] leading-[1.85] font-medium text-slate-700 whitespace-pre-wrap break-words"
                  />
                </DelayedReveal>
              );
            })}
          </div>
        </div>
      </motion.div>

      <DelayedReveal
        delay={cardDelay}
        isLatest={isLatest}
        initial={{ opacity: 0, y: 18, scale: 0.96, filter: 'blur(10px)' }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
      >
        <PaperReceiptBubble
          key={`${scentProfile.id}-${isLatest ? 'live' : 'history'}-${renderMode}-${renderProfile?.renderer || 'unknown'}`}
          data={data}
          scentProfile={scentProfile}
          onNoteChange={onNoteChange}
          isLatest={isLatest}
          renderProfile={renderProfile}
          renderMode={renderMode}
        />
      </DelayedReveal>
    </div>
  );
};

const NeuralWaveform = memo(({ active, color }: { active: boolean; color?: string }) => {
  return (
    <div className="flex items-center justify-center h-8 w-24 relative overflow-hidden" style={{ color: color || '#0f172a' }}>
       <style>{`
         .mask-edges {
           mask-image: linear-gradient(to right, transparent, black 15%, black 85%, transparent);
           -webkit-mask-image: linear-gradient(to right, transparent, black 15%, black 85%, transparent);
         }
       `}</style>
      <div className="mask-edges absolute inset-0">
        
        {/* Wave 1: Fast & Tall */}
        <motion.svg viewBox="0 0 200 40" className="absolute top-0 bottom-0 h-full w-[200%] origin-left" preserveAspectRatio="none"
          animate={active ? { x: ['0%', '-50%'] } : { x: '0%' }}
          transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
        >
          <motion.path 
            initial={false}
            animate={{ d: active 
              ? "M0,20 Q12.5,0 25,20 T50,20 T75,20 T100,20 T125,20 T150,20 T175,20 T200,20" 
              : "M0,20 Q12.5,20 25,20 T50,20 T75,20 T100,20 T125,20 T150,20 T175,20 T200,20" }}
            transition={{ duration: 0.6 }}
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1.5" 
            className="opacity-80"
          />
        </motion.svg>

        {/* Wave 2: Slower & Wider, inverted */}
        <motion.svg viewBox="0 0 200 40" className="absolute top-0 bottom-0 h-full w-[200%] origin-left" preserveAspectRatio="none"
          animate={active ? { x: ['-50%', '0%'] } : { x: '0%' }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
        >
          <motion.path 
            initial={false}
            animate={{ d: active 
              ? "M0,20 Q25,36 50,20 T100,20 T150,20 T200,20" 
              : "M0,20 Q25,20 50,20 T100,20 T150,20 T200,20" }}
            transition={{ duration: 0.6 }}
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1" 
            className="opacity-50"
          />
        </motion.svg>

        {/* Wave 3: Medium & blur glow */}
        <motion.svg viewBox="0 0 200 40" className="absolute top-0 bottom-0 h-full w-[200%] origin-left" preserveAspectRatio="none"
          animate={active ? { x: ['0%', '-50%'] } : { x: '0%' }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
        >
          <motion.path 
            initial={false}
            animate={{ d: active 
              ? "M0,20 Q12.5,10 25,20 T50,20 T75,20 T100,20 T125,20 T150,20 T175,20 T200,20" 
              : "M0,20 Q12.5,20 25,20 T50,20 T75,20 T100,20 T125,20 T150,20 T175,20 T200,20" }}
            transition={{ duration: 0.6 }}
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2.5" 
            className="opacity-30 blur-[2px]"
          />
        </motion.svg>
        
      </div>
    </div>
  );
});

const NoiseOverlay = memo(() => (
  <div className="fixed inset-0 pointer-events-none z-[100] opacity-[0.04] mix-blend-overlay">
    <svg width="100%" height="100%">
      <filter id="noise">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#noise)" />
    </svg>
    <motion.div 
      animate={{ y: ['-100%', '200%'] }}
      transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
      className="absolute top-0 left-0 w-full h-[100px] bg-gradient-to-b from-transparent via-white/20 to-transparent"
    />
  </div>
));

const SvgFilterDefs = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    className="absolute w-0 h-0 overflow-hidden pointer-events-none"
  >
    <defs>
      <filter id="scent-gooey" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="15" result="blur" />
        <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 25 -10" result="goo" />
        <feComposite in="SourceGraphic" in2="goo" operator="atop" />
      </filter>
    </defs>
  </svg>
);

const ScentVisualizer = memo(({ scentId, fullScreen = false }: { scentId: ScentType; fullScreen?: boolean }) => {
  const scent = scentId !== 'None' ? SCENT_PROFILES[scentId] : null;
  if (!scent) return null;

  return (
    <div className={`absolute inset-0 pointer-events-none overflow-hidden ${fullScreen ? 'z-[-1]' : 'z-0'}`}>
      <AnimatePresence mode="wait">
        <motion.div
          key={scentId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6, ease: "easeInOut" }}
          className="absolute inset-0"
        >
          {/* WOODY: Warm, Deep, Grounding Forest Light + Sinking Dust */}
          {scentId === 'Woody' && (
            <div className="absolute inset-0 bg-[#1e1510]/10">
              {/* Deep vertical wood grain light beams translating slowly */}
              {[...Array(fullScreen ? 8 : 4)].map((_, i) => (
                <motion.div
                  key={`w-beam-${i}`}
                  animate={{ 
                    opacity: [0.3, 0.6, 0.3],
                    x: ['-2vw', '2vw', '-2vw'],
                    scaleX: [1, 1.05, 1],
	                  }}
	                  transition={{ duration: 15 + i * 4, repeat: Infinity, ease: "easeInOut", delay: -(Math.random() * 20) }}
		                  className="absolute top-[-10%] bottom-[-10%] w-[12vw] bg-gradient-to-b from-transparent via-[#6b5847] to-[#2b241e] blur-[30px] mix-blend-overlay"
	                  style={{ left: `${10 + i * (100 / (fullScreen ? 9 : 5))}%` }}
	                />
	              ))}
	              {/* Sinking heavy organic particles (warm amber/brown dust) */}
	              {[...Array(fullScreen ? 40 : 15)].map((_, i) => {
		                const size = 3 + Math.random() * 4;
	                return (
	                  <motion.div
	                    key={`w-p-${i}`}
	                    animate={{ 
	                      y: ['-10vh', '110vh'], 
	                      x: [0, Math.sin(i) * 30],
	                      rotate: [0, 180, 360],
		                      opacity: [0, 0.5, 0],
	                    }}
                    transition={{ 
                      duration: 18 + Math.random() * 10, 
                      repeat: Infinity, 
                      ease: "linear", 
                      delay: -(Math.random() * 20) 
                    }}
		                    className="absolute bg-[#8b6b52] mix-blend-multiply"
	                    style={{ 
	                      width: size, 
	                      height: size * 1.5,
                      left: `${Math.random() * 100}%`,
                      borderRadius: `${40 + Math.random() * 20}% ${60 + Math.random() * 20}% ${50 + Math.random() * 20}% ${40 + Math.random() * 20}%`,
                      filter: `blur(${Math.random() * 2}px)`,
		                      boxShadow: '0 0 10px rgba(107, 88, 71, 0.4)'
	                    }}
	                  />
                )
              })}
            </div>
          )}

          {/* CITRUS: Uplifting, Floating Citrus Shapes & Soft Spheres */}
          {scentId === 'Citrus' && (
            <div className="absolute inset-0">
              {/* Uplifting soft ambient glow */}
	              <motion.div
	                animate={{ opacity: [0.15, 0.3, 0.15], y: [0, -20, 0] }}
	                transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
		                className="absolute right-[-10%] bottom-[-10%] w-[60%] h-[60%] bg-gradient-radial from-[#fbbf24] to-transparent blur-[80px]"
	              />
	              <motion.div
	                animate={{ opacity: [0.1, 0.25, 0.1], y: [0, 20, 0] }}
	                transition={{ duration: 7, repeat: Infinity, ease: "easeInOut", delay: 1 }}
		                className="absolute left-[-10%] top-[-10%] w-[50%] h-[50%] bg-gradient-radial from-[#f59e0b] to-transparent blur-[80px]"
	              />

               {/* Geometric Citrus Abstractions (Oranges, Lemons, Wedges) */}
              {[...Array(fullScreen ? 24 : 12)].map((_, i) => {
                const type = i % 3; // 0: full circle, 1: half circle, 2: sliced arc
		                const size = 15 + Math.random() * 30;
                
                let borderRadius = '50%';
                let height = size;
                if (type === 1) {
                   borderRadius = `${size}px ${size}px 0 0`;
                   height = size / 2;
                }
                
                return (
                  <motion.div
                    key={`c-geom-${i}`}
                    animate={{
	                      y: ['110vh', '-10vh'],
	                      x: [0, Math.sin(i) * 100 + (Math.random() - 0.5) * 50],
	                      scale: [0.7, 1.2, 0.7],
		                      opacity: [0, 0.8, 0],
	                      rotate: [0, Math.random() > 0.5 ? 240 : -240],
	                    }}
	                    transition={{ 
		                      duration: 10 + Math.random() * 10, 
                      repeat: Infinity, 
                      ease: "linear", 
                      delay: -(Math.random() * 20) 
                    }}
                    className="absolute"
                    style={{
                      left: `${Math.random() * 100}%`,
                      width: size,
                      height: height,
                      borderRadius: borderRadius,
                      border: type === 2 ? `2px solid rgba(251, 191, 36, 0.6)` : '1px solid rgba(255,255,255,0.4)',
                      borderBottom: type === 2 ? 'none' : undefined,
                      backgroundColor: type === 2 ? 'transparent' : (i % 2 === 0 ? 'rgba(252, 211, 77, 0.2)' : 'rgba(245, 158, 11, 0.2)'),
                      backdropFilter: type === 2 ? 'none' : 'blur(4px)',
                      boxShadow: type === 2 ? 'none' : 'inset 0 0 10px rgba(255,255,255,0.3)',
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* FLORAL: Petal Layers + Drifting Pink/Purple Petals */}
          {scentId === 'Floral' && (
            <div className="absolute inset-0">
               {/* Soft multi-layered floral background rotating */}
		               <div className="absolute inset-0 flex items-center justify-center mix-blend-multiply opacity-80" style={{ filter: 'url(#scent-gooey)' }}>
                {[...Array(6)].map((_, i) => (
                  <motion.div
                    key={`f-layer-${i}`}
                    animate={{ rotate: 360, scale: [0.9, 1.2, 0.9] }}
                    transition={{ duration: 25 + i * 8, repeat: Infinity, ease: "linear", delay: -(Math.random() * 20) }}
                    className="absolute rounded-[45%_55%_40%_60%] border-[2px] border-rose-400/30"
                    style={{ 
                      width: `${40 + i * 10}vw`, 
                      height: `${40 + i * 10}vw`,
		                      backgroundColor: i % 2 === 0 ? 'rgba(244, 63, 94, 0.08)' : 'rgba(217, 70, 239, 0.08)'
                    }}
                  />
                ))}
              </div>
              {/* Pink-Purple translucent drifting petals */}
              {[...Array(fullScreen ? 35 : 15)].map((_, i) => (
                <motion.div
                  key={`f-petal-${i}`}
                  animate={{ 
                    y: ['-10vh', '110vh'], 
                    x: [0, (Math.random() - 0.5) * 150 + Math.sin(i) * 50],
                    rotateX: [0, 360],
                    rotateY: [0, 360],
                    rotateZ: [0, 180, 360],
		                    opacity: [0, 0.8, 0],
                    scale: [0.6, 1.2, 0.6]
                  }}
                  transition={{ 
                    duration: 12 + Math.random() * 8, 
                    repeat: Infinity, 
                    delay: -(Math.random() * 20),
                    ease: "easeInOut"
                  }}
		                  className="absolute w-8 h-6 rounded-[0_100%_0_100%] backdrop-blur-[2px] shadow-[0_2px_10px_rgba(244,63,94,0.1)]"
                  style={{ 
                    left: `${Math.random() * 100}%`,
                    border: '1px solid rgba(255,255,255,0.2)',
                    background: i % 2 === 0 
                      ? 'linear-gradient(135deg, rgba(244,63,94,0.3), rgba(251,113,133,0.05))' 
                      : 'linear-gradient(135deg, rgba(217,70,239,0.3), rgba(232,121,249,0.05))'
                  }}
                />
              ))}
            </div>
          )}

	          {/* MUSK: Velvet Clouds with Organic Movement */}
		          {scentId === 'Musk' && (
		            <div className="absolute inset-0 overflow-hidden mix-blend-multiply">
		               {/* Soft organic gradients resembling velvet folds */}
		               {[...Array(fullScreen ? 5 : 3)].map((_, i) => (
	                  <motion.div
	                    key={`m-fold-${i}`}
                    animate={{ 
                      x: ['-5%', '5%', '-5%'], 
                      y: ['-5%', '5%', '-5%'], 
                      scale: [1, 1.1, 1],
                      rotate: [-5, 5, -5]
                    }}
                    transition={{ 
                      duration: 20 + i * 5, 
                      repeat: Infinity, 
                      ease: "easeInOut",
                      delay: -(Math.random() * 20)
                    }}
                    className="absolute rounded-full"
                    style={{
                      width: `${80 + i * 20}vw`,
                      height: `${60 + i * 15}vh`,
	                      left: `${-20 + (i * 20)}%`,
	                      top: `${-10 + (i % 2) * 30}%`,
		                      background: `radial-gradient(ellipse at center, ${scent.colors.secondary}55 0%, transparent 60%)`,
		                      filter: 'blur(50px)',
		                    }}
		                  />
		                ))}
		            </div>
		          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
});

const getAiErrorMessage = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error || '');

  if (raw.includes('MiniMax') || raw.includes('base_resp') || raw.includes('authorized_error')) {
    return `Aura could not complete this MiniMax Token Plan request: ${raw}`;
  }

  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED') || raw.toLowerCase().includes('quota')) {
    const retryMatch = raw.match(/retry in ([0-9.]+)s/i);
    const retryText = retryMatch ? ` Please retry in about ${Math.ceil(Number(retryMatch[1]))} seconds.` : ' Please retry later.';
    return `Aura reached the model quota or rate limit.${retryText}`;
  }

  if (raw.includes('API key') || raw.includes('API_KEY') || raw.includes('403') || raw.includes('401')) {
    return 'Aura could not connect to the model provider. The API key may be invalid, disabled, or unauthorized.';
  }

  if (raw.toLowerCase().includes('fetch') || raw.toLowerCase().includes('network')) {
    return 'Aura could not reach the model provider. The frontend is still running, but the model request failed on the network.';
  }

  return 'Aura could not complete this generation. The frontend is still running, but the model request returned an error.';
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      type: 'agent',
      text: "I am Aura. Please share how you are feeling inside at this moment. I will synthesize the right emotional environment for you.",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('lite');
  const [activeScentId, setActiveScentId] = useState<ScentType>('Woody');
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeNote, setActiveNote] = useState<'top' | 'heart' | 'base'>('base');
  const [fanConnectionStatus, setFanConnectionStatus] = useState<'offline' | 'connecting' | 'online'>('offline');
  const [fanConnectionMessage, setFanConnectionMessage] = useState(`Select ${FAN_DEVICE_NAME} in the browser chooser.`);
  const [fanStatus, setFanStatus] = useState<Record<FanId, FanSpeed>>({ 1: 0, 2: 0, 3: 0, 4: 0 });
  const [renderProfile, setRenderProfile] = useState<RenderProfile>(DEFAULT_RENDER_PROFILE);
  const [renderMode, setRenderMode] = useState<RenderMode>('auto');
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const fanDeviceRef = useRef<any>(null);
  const fanRxCharacteristicRef = useRef<any>(null);
  const fanTxCharacteristicRef = useRef<any>(null);
  const pendingFanPlanRef = useRef<FanControlPlan | null>(null);
  const isExecutingFanPlanRef = useRef(false);
  const fanReportedStatusRef = useRef<Record<FanId, FanSpeed>>({ 1: 0, 2: 0, 3: 0, 4: 0 });

  const activeScent = activeScentId === 'None' ? null : SCENT_PROFILES[activeScentId];

  const handleFeedScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior
      });
    }
  }, []);

  const requestAutoScroll = useCallback(() => {
    if (shouldAutoScrollRef.current) {
      scrollToBottom();
    }
  }, [scrollToBottom]);

  useEffect(() => {
    requestAutoScroll();
  }, [messages, requestAutoScroll]);

  useEffect(() => {
    setRenderProfile(detectBrowserRenderProfile());
  }, []);

  const applyFanStatusText = useCallback((text: string) => {
    const match = text.match(/F1=(0|70|85|100)%[, ]+\s*F2=(0|70|85|100)%[, ]+\s*F3=(0|70|85|100)%[, ]+\s*F4=(0|70|85|100)%/i);
    if (!match) {
      return null;
    }

    const nextStatus = {
      1: Number(match[1]) as FanSpeed,
      2: Number(match[2]) as FanSpeed,
      3: Number(match[3]) as FanSpeed,
      4: Number(match[4]) as FanSpeed,
    };
    fanReportedStatusRef.current = nextStatus;
    setFanStatus(nextStatus);
    return nextStatus;
  }, []);

  const handleFanNotification = useCallback((event: any) => {
    try {
      const text = new TextDecoder('utf-8').decode(event.target.value).replace(/\r/g, '\n');
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.length) {
        return;
      }

      for (const line of lines) {
        applyFanStatusText(line);
      }

      setFanConnectionMessage(lines[lines.length - 1]);
    } catch (error) {
      console.error('Fan notification parse error:', error);
    }
  }, [applyFanStatusText]);

  const sendFanCommand = useCallback(async (command: string) => {
    const rxCharacteristic = fanRxCharacteristicRef.current;
    if (!rxCharacteristic) {
      throw new Error('Diffuser is not connected.');
    }

    const data = new TextEncoder().encode(`${command}\n`);
    const props = rxCharacteristic.properties || {};

    try {
      if (props.write && rxCharacteristic.writeValueWithResponse) {
        await rxCharacteristic.writeValueWithResponse(data);
      } else if (props.writeWithoutResponse && rxCharacteristic.writeValueWithoutResponse) {
        await rxCharacteristic.writeValueWithoutResponse(data);
      } else if (rxCharacteristic.writeValue) {
        await rxCharacteristic.writeValue(data);
      } else {
        throw new Error('No supported GATT write method was exposed by the diffuser characteristic.');
      }
    } catch (firstError) {
      if (props.writeWithoutResponse && rxCharacteristic.writeValueWithoutResponse) {
        await rxCharacteristic.writeValueWithoutResponse(data);
      } else if (props.write && rxCharacteristic.writeValueWithResponse) {
        await rxCharacteristic.writeValueWithResponse(data);
      } else {
        throw firstError;
      }
    }

    return true;
  }, []);

  const disconnectFanController = useCallback(() => {
    const device = fanDeviceRef.current;
    const txCharacteristic = fanTxCharacteristicRef.current;

    try {
      if (txCharacteristic) {
        txCharacteristic.removeEventListener('characteristicvaluechanged', handleFanNotification);
      }
    } catch {}

    try {
      if (device?.gatt?.connected) {
        device.gatt.disconnect();
      }
    } catch {}

    fanDeviceRef.current = null;
    fanRxCharacteristicRef.current = null;
    fanTxCharacteristicRef.current = null;
    isExecutingFanPlanRef.current = false;
    fanReportedStatusRef.current = { 1: 0, 2: 0, 3: 0, 4: 0 };
    setFanConnectionStatus('offline');
    setFanConnectionMessage('Diffuser disconnected.');
    setFanStatus({ 1: 0, 2: 0, 3: 0, 4: 0 });
  }, [handleFanNotification]);

  const connectFanController = useCallback(async () => {
    try {
      const bluetooth = (navigator as any).bluetooth;
      if (!bluetooth) {
        throw new Error('This browser does not support Web Bluetooth. Use Chrome or Edge.');
      }

      if (!window.isSecureContext) {
        throw new Error('Web Bluetooth requires localhost or HTTPS. Do not open the page from a LAN IP over plain HTTP.');
      }

      if (typeof bluetooth.getAvailability === 'function') {
        const available = await bluetooth.getAvailability();
        if (!available) {
          throw new Error('Bluetooth is unavailable on this device. Check that the adapter is enabled.');
        }
      }

      if (fanConnectionStatus === 'online') {
        disconnectFanController();
        return;
      }

      setFanConnectionStatus('connecting');
      setFanConnectionMessage(`Choose ${FAN_DEVICE_NAME} in the browser Bluetooth picker.`);
      const device = await bluetooth.requestDevice({
        filters: [{ namePrefix: FAN_DEVICE_NAME, services: [FAN_SERVICE_UUID] }],
        optionalServices: [FAN_SERVICE_UUID],
      });

      device.addEventListener('gattserverdisconnected', () => {
        fanDeviceRef.current = null;
        fanRxCharacteristicRef.current = null;
        fanTxCharacteristicRef.current = null;
        fanReportedStatusRef.current = { 1: 0, 2: 0, 3: 0, 4: 0 };
        setFanConnectionStatus('offline');
        setFanConnectionMessage('Diffuser disconnected.');
        setFanStatus({ 1: 0, 2: 0, 3: 0, 4: 0 });
      });

      setFanConnectionMessage(`Selected ${device.name || 'BLE device'}. Connecting...`);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(FAN_SERVICE_UUID);
      const rxCharacteristic = await service.getCharacteristic(FAN_RX_UUID);
      const txCharacteristic = await service.getCharacteristic(FAN_TX_UUID);
      txCharacteristic.addEventListener('characteristicvaluechanged', handleFanNotification);
      await txCharacteristic.startNotifications();

      fanDeviceRef.current = device;
      fanRxCharacteristicRef.current = rxCharacteristic;
      fanTxCharacteristicRef.current = txCharacteristic;
      fanReportedStatusRef.current = { 1: 0, 2: 0, 3: 0, 4: 0 };
      setFanConnectionStatus('online');
      setFanConnectionMessage(`Connected to ${device.name || FAN_DEVICE_NAME}.`);
      await sendFanCommand('STATUS');
      if (pendingFanPlanRef.current) {
        const queuedPlan = pendingFanPlanRef.current;
        pendingFanPlanRef.current = null;
        window.setTimeout(() => {
          void executeFanPlan(queuedPlan);
        }, 300);
      }
    } catch (error) {
      console.error('Fan connection error:', error);
      setFanConnectionStatus('offline');
      if (error instanceof Error && error.name === 'NotFoundError') {
        setFanConnectionMessage(`${FAN_DEVICE_NAME} was not found. Make sure the ESP32 is powered on and advertising the final firmware.`);
      } else {
        setFanConnectionMessage(error instanceof Error ? error.message : 'Bluetooth connection failed.');
      }
    }
  }, [disconnectFanController, fanConnectionStatus, handleFanNotification, sendFanCommand]);

  useEffect(() => {
    return () => {
      disconnectFanController();
    };
  }, [disconnectFanController]);

  useEffect(() => {
    const handlePageExit = () => {
      disconnectFanController();
    };

    window.addEventListener('pagehide', handlePageExit);
    window.addEventListener('beforeunload', handlePageExit);

    return () => {
      window.removeEventListener('pagehide', handlePageExit);
      window.removeEventListener('beforeunload', handlePageExit);
    };
  }, [disconnectFanController]);

  const sleep = useCallback((ms: number) => {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }, []);

  const getExpectedFanStatus = useCallback((plan: FanControlPlan): Record<FanId, FanSpeed> => {
    const nextStatus: Record<FanId, FanSpeed> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    plan.fans.forEach((output) => {
      nextStatus[output.fan] = output.speed;
    });
    return nextStatus;
  }, []);

  const hasExpectedFanStatus = useCallback((expected: Record<FanId, FanSpeed>) => {
    const actual = fanReportedStatusRef.current;
    return (
      actual[1] === expected[1] &&
      actual[2] === expected[2] &&
      actual[3] === expected[3] &&
      actual[4] === expected[4]
    );
  }, []);

  const waitForExpectedFanStatus = useCallback(async (expected: Record<FanId, FanSpeed>, timeoutMs = 1600) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (hasExpectedFanStatus(expected)) {
        return true;
      }
      await sleep(120);
    }
    return hasExpectedFanStatus(expected);
  }, [hasExpectedFanStatus, sleep]);

  const applyFanPlanOnce = useCallback(async (plan: FanControlPlan) => {
    const expectedStatus = getExpectedFanStatus(plan);
    for (const command of plan.commands) {
      await sendFanCommand(command);
      await sleep(320);
    }

    await sendFanCommand('STATUS');
    return waitForExpectedFanStatus(expectedStatus);
  }, [getExpectedFanStatus, sendFanCommand, sleep, waitForExpectedFanStatus]);

  const executeFanPlan = useCallback(async (plan?: FanControlPlan) => {
    if (!plan) {
      return;
    }

    if (!fanRxCharacteristicRef.current) {
      pendingFanPlanRef.current = plan;
      setFanConnectionMessage('Diffuser command queued. Connect the device to apply it.');
      return;
    }

    if (isExecutingFanPlanRef.current) {
      pendingFanPlanRef.current = plan;
      setFanConnectionMessage('Diffuser is busy. The latest scent command is queued.');
      return;
    }

    isExecutingFanPlanRef.current = true;
    pendingFanPlanRef.current = null;
    setFanConnectionMessage('Applying diffuser output...');

    try {
      let applied = await applyFanPlanOnce(plan);
      if (!applied) {
        setFanConnectionMessage('Diffuser did not confirm the latest scent yet. Retrying...');
        await sleep(420);
        applied = await applyFanPlanOnce(plan);
      }

      if (!applied) {
        throw new Error('Diffuser did not acknowledge the latest scent command.');
      }

      setFanConnectionMessage('Diffuser synced to the latest scent.');
    } catch (error) {
      console.error('Fan plan execution error:', error);
      pendingFanPlanRef.current = plan;
      setFanConnectionMessage(error instanceof Error ? error.message : 'Diffuser command failed and was re-queued.');
    } finally {
      isExecutingFanPlanRef.current = false;
      if (pendingFanPlanRef.current && fanRxCharacteristicRef.current) {
        const queuedPlan = pendingFanPlanRef.current;
        pendingFanPlanRef.current = null;
        window.setTimeout(() => {
          void executeFanPlan(queuedPlan);
        }, 300);
      }
    }
  }, [applyFanPlanOnce, sleep]);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isSyncing) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      type: 'user',
      text: inputValue,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => [...prev, userMsg]);
    setInputValue('');
    setIsSyncing(true);

    try {
      const generated = await generateScentResponse(llmProvider, inputValue);

      if (typeof generated !== 'string') {
        const agentMsg: Message = {
          id: (Date.now() + 2).toString(),
          type: 'agent',
          scentData: {
            scent: generated.scent,
            introMessage: generated.introMessage,
            topNoteText: generated.topNoteText,
            heartNoteText: generated.heartNoteText,
            baseNoteText: generated.baseNoteText,
            fanControl: generated.fanControl,
          },
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };

        setMessages(prev => [...prev, agentMsg]);
        setActiveScentId(generated.scent);
        setActiveNote('top');
        await executeFanPlan(generated.fanControl);
      } else {
        const agentMsg: Message = {
          id: (Date.now() + 1).toString(),
          type: 'agent',
          text: generated,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        setMessages(prev => [...prev, agentMsg]);
      }
    } catch (error) {
      console.error("AI Error:", error);
      const agentMsg: Message = {
        id: (Date.now() + 3).toString(),
        type: 'agent',
        text: getAiErrorMessage(error),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages(prev => [...prev, agentMsg]);
    } finally {
      setIsSyncing(false);
    }
  }, [executeFanPlan, inputValue, isSyncing, llmProvider]);

  return (
    <div className="min-h-screen flex items-center justify-center sm:py-8 font-sans selection:bg-rose-100 transition-colors duration-500 relative overflow-hidden"
         style={{ backgroundColor: activeScent?.colors.bg || '#FBF8F2' }}>
      
      <SvgFilterDefs />
      <NoiseOverlay />
      
      {/* GLOBAL BACKGROUND SCENT VISUALIZER */}
      <ScentVisualizer scentId={activeScentId} fullScreen />
      
      {/* Background Aura Dots */}
      <div className="fixed inset-0 pointer-events-none z-[1]">
        <motion.div 
          key={activeScentId + "-aura-1"}
          initial={{ opacity: 0 }}
          animate={{ x: [0, 40, 0], y: [0, 20, 0], opacity: 1 }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
          style={{ background: `radial-gradient(circle at 20% 30%, ${activeScent?.colors.primary}15 0%, transparent 40%)` }}
          className="absolute inset-[-50%] transition-colors duration-500"
        />
        <motion.div 
          key={activeScentId + "-aura-2"}
          initial={{ opacity: 0 }}
          animate={{ x: [0, -30, 0], y: [0, -10, 0], opacity: 1 }}
          transition={{ duration: 25, repeat: Infinity, ease: "easeInOut" }}
          style={{ background: `radial-gradient(circle at 80% 70%, ${activeScent?.colors.accent}15 0%, transparent 40%)` }}
          className="absolute inset-[-50%] transition-colors duration-500"
        />
      </div>

      {/* Terminal Core (Ice Glass) */}
      <div className="relative w-full h-full sm:h-[820px] sm:w-[420px] bg-white/20 backdrop-blur-[32px] sm:rounded-[48px] shadow-[0_32px_100px_rgba(0,0,0,0.06)] border border-white/50 overflow-hidden flex flex-col transition-all duration-500 z-10">
        
        {/* Physical Gloss Edge */}
        <div 
          className="absolute inset-0 border-[1.5px] rounded-[48px] pointer-events-none z-50 transition-colors duration-500" 
          style={{ borderColor: `${activeScent?.colors.primary}20` }}
        />
        
        <ScentVisualizer scentId={activeScentId} />

        {/* Dashboard Status */}
        <div className="absolute top-0 left-0 w-full px-10 pt-4 flex justify-between items-center z-[100]">
           <NeuralWaveform active={isSyncing} color={activeScent?.colors.primary} />
           <div className="flex items-center gap-3 text-[8px] font-mono font-bold tracking-[0.2em] text-slate-400 uppercase">
             <span className="transition-colors duration-500" style={{ color: activeScent?.colors.primary }}>LINK_01</span>
             <button
               onClick={connectFanController}
               disabled={fanConnectionStatus === 'connecting'}
               className="bg-white/40 border border-white/60 rounded-full px-2 py-1 text-[8px] font-mono font-black uppercase tracking-[0.16em] text-slate-600 outline-none disabled:opacity-50"
               style={{ color: fanConnectionStatus === 'online' ? activeScent?.colors.primary : undefined }}
               aria-label="Connect scent fan controller"
             >
               FAN_{fanConnectionStatus === 'online' ? 'ON' : fanConnectionStatus === 'connecting' ? 'SYNC' : 'OFF'}
             </button>
             <select
               value={llmProvider}
               onChange={(event) => setLlmProvider(event.target.value as LlmProvider)}
               disabled={isSyncing}
               className="bg-white/40 border border-white/60 rounded-full px-2 py-1 text-[8px] font-mono font-black uppercase tracking-[0.16em] text-slate-600 outline-none disabled:opacity-50"
               aria-label="LLM provider"
             >
               <option value="gemini">Gemini</option>
               <option value="lite">LiteLLM</option>
             </select>
             <select
               value={renderMode}
               onChange={(event) => setRenderMode(event.target.value as RenderMode)}
               className="bg-white/40 border border-white/60 rounded-full px-2 py-1 text-[8px] font-mono font-black uppercase tracking-[0.16em] text-slate-600 outline-none disabled:opacity-50"
               aria-label="Card effects quality"
             >
               <option value="auto">FX AUTO</option>
               <option value="balanced">FX BAL</option>
               <option value="full">FX FULL</option>
             </select>
             <span className={isSyncing ? "animate-pulse" : ""} style={{ color: isSyncing ? activeScent?.colors.accent : 'inherit' }}>
               {isSyncing ? "SYNCING" : "STANDBY"}
             </span>
           </div>
        </div>

        <div className="absolute top-8 left-0 w-full px-10 z-[95]">
          <div className="ml-auto max-w-[240px] text-right">
            <p className="text-[9px] leading-[1.4] font-mono tracking-[0.08em] text-slate-400">
              {fanConnectionMessage}
            </p>
            <p className="mt-1 text-[8px] font-mono text-slate-400">
              F1 {fanStatus[1]} | F2 {fanStatus[2]} | F3 {fanStatus[3]} | F4 {fanStatus[4]}
            </p>
            <p className="mt-1 text-[8px] font-mono text-slate-400 truncate">
              GPU {(renderMode === 'auto' ? renderProfile.tier : renderMode).toUpperCase()} | {renderProfile.renderer}
            </p>
          </div>
        </div>

        {/* Header Navigation */}
        <header className="absolute top-10 w-full z-[100] flex justify-between items-center px-10 h-16">
          <button className="w-10 h-10 rounded-2xl bg-white/40 backdrop-blur-xl border border-white/60 flex items-center justify-center text-slate-700 shadow-sm transition-all hover:scale-105 active:scale-95 group">
            <Menu size={18} strokeWidth={2.5} className="group-hover:rotate-90 transition-transform duration-500" />
          </button>
          <div className="flex flex-col items-center">
            <h1 className="text-[14px] font-black tracking-[0.5em] text-slate-900 ml-2 uppercase transition-colors duration-500"
                style={{ color: activeScent?.colors.primary }}>
              Aura
            </h1>
            <motion.div 
              layoutId="header-bar"
              className="h-1 w-12 rounded-full mt-1 transition-colors duration-500" 
              style={{ backgroundColor: activeScent?.colors.accent }}
            />
          </div>
          <button className="w-10 h-10 rounded-2xl bg-white/40 backdrop-blur-xl border border-white/60 flex items-center justify-center text-slate-700 shadow-sm transition-all hover:scale-105 active:scale-95 overflow-hidden">
            <motion.div 
              animate={{ rotate: 360 }}
              transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
              className="absolute inset-0 opacity-10 transition-colors duration-500"
              style={{ background: `conic-gradient(from 0deg, transparent, ${activeScent?.colors.accent}, transparent)` }}
            />
            <User size={18} strokeWidth={2.5} />
          </button>
        </header>

        {/* Main Feed */}
        <main 
          ref={scrollRef}
          onScroll={handleFeedScroll}
          className="absolute inset-0 overflow-y-auto pb-44 pt-32 px-8 space-y-10 scrollbar-hide z-10 scroll-smooth"
        >
          {activeScent && (
            <motion.div 
              key={activeScentId + "-title"}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center space-y-2 mb-12 mt-4"
            >
              <span className="text-[9px] font-mono font-black uppercase tracking-[0.3em] transition-colors duration-500"
                    style={{ color: activeScent.colors.accent }}>
                {`// scenario: calibrated`}
              </span>
              <h2 className="text-5xl font-serif font-light text-slate-900 tracking-tight leading-tight pt-1">
                {activeScent.name.split(' ')[0]}
                <span className="block italic text-3xl font-medium transition-colors duration-500"
                      style={{ color: `${activeScent.colors.primary}80` }}>
                  {activeScent.name.split(' ')[1]}
                </span>
              </h2>
            </motion.div>
          )}

          {/* Scent Cards (Visual Context) */}
          {activeScent && (
            <div className="grid grid-cols-3 gap-3 px-2">
              {(['top', 'heart', 'base'] as const).map((noteKey) => {
                const note = activeScent.notes[noteKey];
                const isActive = activeNote === noteKey;
                return (
                  <motion.div 
                    key={noteKey}
                    layout
                    className={`relative p-3 rounded-[24px] transition-all duration-500 shadow-sm border border-white/50 text-center flex flex-col justify-center items-center gap-1.5 ${
                      isActive 
                        ? 'bg-white/90 scale-105 z-10' 
                        : 'bg-white/40 pb-2 border-white/40 opacity-70'
                    }`}
                  >
                    {isActive && (
                      <motion.div 
                        layoutId="active-note-outline"
                        className="absolute inset-0 rounded-[24px] border border-transparent pointer-events-none transition-colors duration-500"
                        style={{ borderBottomColor: activeScent.colors.accent + '60' }}
                      />
                    )}
                    <div className="p-1.5 rounded-full transition-colors duration-500"
                         style={{ 
                           backgroundColor: isActive ? `${activeScent.colors.primary}15` : 'transparent',
                           color: isActive ? activeScent.colors.primary : 'rgb(148,163,184)'
                         }}>
                      <note.icon size={14} strokeWidth={isActive ? 2.5 : 2} />
                    </div>
                    <span className="text-[7px] font-mono font-black uppercase tracking-widest text-slate-400">{noteKey}</span>
                  </motion.div>
                );
              })}
            </div>
          )}

          {/* Chat Logs */}
          <div className="space-y-6 pt-6 relative px-2">
             {messages.map((msg, index) => {
               const isLatest = index === messages.length - 1;
               return (
                 <motion.div 
                   key={msg.id}
                   initial={{ opacity: 0, scale: 0.98, y: 10 }}
                   animate={{ opacity: 1, scale: 1, y: 0 }}
                   className={`flex gap-4 ${msg.type === 'user' ? 'flex-row-reverse' : ''}`}
                 >
                   <div className={`w-6 h-6 rounded-xl flex-shrink-0 flex items-center justify-center text-[8px] font-mono font-black z-10 shadow-sm transition-colors duration-500 ${
                        msg.type === 'agent' ? 'backdrop-blur-md border border-white/20' : 'bg-white/40 backdrop-blur-md border border-white/40'
                      }`}
                        style={{ 
                          backgroundColor: msg.type === 'agent' ? `${activeScent?.colors.primary}cc` : undefined,
                          color: msg.type === 'agent' ? '#fff' : '#64748b'
                        }}>
                     {msg.type === 'agent' ? 'A' : 'U'}
                   </div>
                   <div className={`flex min-w-0 ${msg.type === 'agent' && msg.scentData ? 'flex-1 justify-start' : msg.type === 'user' ? 'flex-1 justify-end' : 'justify-start'}`}>
                     {msg.type === 'agent' && msg.scentData ? (
                        <ScentResponseFlow 
                          data={msg.scentData} 
                          scentProfile={SCENT_PROFILES[msg.scentData.scent]} 
                          onNoteChange={(note: any) => isLatest && setActiveNote(note)}
                          onAutoScrollRequest={requestAutoScroll}
                          isLatest={isLatest}
                          renderProfile={renderProfile}
                          renderMode={renderMode}
                        />
                     ) : msg.type === 'agent' ? (
                        <div className={`inline-block py-4 px-5 rounded-[24px] bg-white/20 backdrop-blur-2xl border border-white/40 shadow-[0_8px_32px_rgba(0,0,0,0.03)] transition-all duration-500 rounded-tl-[8px]`}>
                           {msg.id !== '1' ? (
                              <AnimatedText text={msg.text || ""} />
                           ) : (
                              <p className="text-[12px] leading-[1.8] font-medium text-slate-700">{msg.text}</p>
                           )}
                        </div>
                     ) : (
                        <div className={`inline-block py-4 px-5 rounded-[24px] bg-white/20 backdrop-blur-2xl border border-white/40 shadow-[0_8px_32px_rgba(0,0,0,0.03)] transition-all duration-500 rounded-tr-[8px]`}>
                           <p className="text-[12px] leading-[1.8] font-medium text-slate-700">{msg.text}</p>
                        </div>
                     )}
                   </div>
                 </motion.div>
               );
             })}
          </div>
        </main>

        {/* Input Terminal */}
        <div className="absolute bottom-[90px] left-0 w-full px-10 z-[200]">
           <div className="relative bg-white/40 border border-white/60 rounded-full h-14 pl-6 pr-2 py-2 backdrop-blur-3xl shadow-[0_8px_32px_rgba(0,0,0,0.06)] flex items-center group transition-all duration-500 focus-within:bg-white/60"
                style={{ borderColor: isSyncing ? activeScent?.colors.accent : 'initial' }}>
              <input 
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                type="text" 
                placeholder="Synchronize neural state..."
                className="flex-1 bg-transparent border-none outline-none text-xs font-bold text-slate-900 placeholder:text-slate-500 pb-0.5"
              />
              <button 
                onClick={handleSend}
                disabled={!inputValue.trim() || isSyncing}
                className="w-10 h-10 bg-slate-900 text-white rounded-full flex items-center justify-center shadow-lg transition-all duration-500 active:scale-90 disabled:opacity-20 translate-x-[-2px] hover:shadow-xl"
                style={{ backgroundColor: activeScent?.colors.primary }}
              >
                <Send size={16} strokeWidth={3} />
              </button>
           </div>
        </div>

        {/* System Bar */}
        <nav className="absolute bottom-0 w-full h-[88px] px-12 bg-white/20 backdrop-blur-[40px] border-t border-white/40 flex items-center justify-between z-[200]">
           <div className="flex flex-col items-center gap-1.5 cursor-pointer text-slate-900 transition-colors duration-500"
                style={{ color: activeScent?.colors.primary }}>
             <div className="relative">
               <Wind size={20} strokeWidth={2.5} />
               <motion.div 
                 layoutId="nav-dot"
                 className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full transition-colors duration-500" 
                 style={{ backgroundColor: activeScent?.colors.accent }}
               />
             </div>
             <span className="text-[7px] font-black uppercase tracking-widest">DIFFUSER</span>
           </div>
           <div className="flex flex-col items-center gap-1.5 cursor-pointer text-slate-400 transition-colors hover:text-slate-600">
             <ShoppingBag size={20} strokeWidth={2.5} />
             <span className="text-[7px] font-black uppercase tracking-widest">STASH</span>
           </div>
           <div className="flex flex-col items-center gap-1.5 cursor-pointer text-slate-400 transition-colors hover:text-slate-600">
             <ShieldCheck size={20} strokeWidth={2.5} />
             <span className="text-[7px] font-black uppercase tracking-widest">SECURITY</span>
           </div>
        </nav>
      </div>
    </div>
  );
}
