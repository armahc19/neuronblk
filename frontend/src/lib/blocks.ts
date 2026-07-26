import { Boxes, Play, Variable, Type, Terminal, GitBranch, Repeat, FunctionSquare, FileText, Cloud, Sparkles, Database, CircleDot } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type BlockField =
  | { name: string; kind: "text" | "number"; placeholder?: string; default?: string; width?: number }
  | { name: string; kind: "select"; options: string[]; default?: string; width?: number };

export type BlockDef = {
  id: string;
  label: string;
  category: string;
  description: string;
  /** Inline editable fields shown inside the block, Scratch-style. */
  fields?: BlockField[];
  /** Sentence template with {fieldName} placeholders shown around inputs. */
  template?: string;
  /** Where this block is allowed to appear. Omit for "both" (the common
   * case). fn.return only makes sense inside a function's own body;
   * everything else that's context-restricted follows the same idea. */
  contexts?: ("project" | "function")[];
};

export type BlockCategory = {
  id: string;
  name: string;
  icon: LucideIcon;
  color: string;
  blocks: BlockDef[];
};

export const BLOCK_CATEGORIES: BlockCategory[] = [
  {
    id: "start",
    name: "Terminal",
    icon: Play,
    color: "start",
    blocks: [
      { id: "start.main", label: "Start", category: "start", description: "Entry point of your program", template: "Start", contexts: ["project"] },
      { id: "start.stop", label: "Stop", category: "start", description: "End point of your program", template: "Stop", contexts: ["project"] },
    ],
  },
  {
    id: "variables",
    name: "Variables",
    icon: Variable,
    color: "variable",
    blocks: [
      {
        id: "var.set",
        label: "Set variable",
        category: "variables",
        description: "Assign a value to a variable",
        template: "{name} = {value}",
        fields: [
          { name: "name", kind: "text", placeholder: "Enter variable", default: "", width: 95 },
          { name: "value", kind: "text", placeholder: "Enter value", default: "", width: 85 },
        ],
      },
      {
        id: "var.get",
        label: "Get variable",
        category: "variables",
        description: "Read a variable value",
        template: "get {name}",
        fields: [{ name: "name", kind: "text", placeholder: "x", default: "x", width: 80 }],
      },
      {
        id: "var.math",
        label: "Math operation",
        category: "variables",
        description: "Add, subtract, multiply…",
        template: "{a} {op} {b}",
        fields: [
          { name: "a", kind: "text", placeholder: "a", default: "a", width: 60 },
          { name: "op", kind: "select", options: ["+", "-", "×", "÷", "%"], default: "+", width: 56 },
          { name: "b", kind: "text", placeholder: "b", default: "b", width: 60 },
        ],
      },
    ],
  },
  {
    id: "input",
    name: "Input",
    icon: Type,
    color: "input",
    blocks: [
      {
        id: "input.text",
        label: "Ask for text",
        category: "input",
        description: "Prompt user for input",
        template: "ask {prompt} → {var}",
        fields: [
          { name: "prompt", kind: "text", placeholder: "Enter text", default: "Enter text", width: 120 },
          { name: "var", kind: "text", placeholder: "name", default: "name", width: 80 },
        ],
      },
      {
        id: "input.number",
        label: "Ask for number",
        category: "input",
        description: "Prompt user for a number",
        template: "ask number {prompt} → {var}",
        fields: [
          { name: "prompt", kind: "text", placeholder: "Enter number", default: "Enter number", width: 120 },
          { name: "var", kind: "text", placeholder: "value", default: "value", width: 80 },
        ],
      },
    ],
  },
  {
    id: "output",
    name: "Output",
    icon: Terminal,
    color: "output",
    blocks: [
      {
        id: "out.print",
        label: "Print to console",
        category: "output",
        description: "Write a line to output",
        template: "print {text}",
        fields: [{ name: "text", kind: "text", placeholder: "Hello world", default: "Hello world", width: 160 }],
      },
      {
        id: "out.format",
        label: "Format string",
        category: "output",
        description: "Build a formatted string",
        template: "format {template} → {var}",
        fields: [
          { name: "template", kind: "text", placeholder: "Hi {name}", default: "Hi {name}", width: 140 },
          { name: "var", kind: "text", placeholder: "msg", default: "msg", width: 70 },
        ],
      },
    ],
  },
  {
    id: "conditions",
    name: "Conditions",
    icon: GitBranch,
    color: "condition",
    blocks: [
      {
        id: "if.then",
        label: "If / Else",
        category: "conditions",
        description: "Branch on a condition",
        template: "if {cond}",
        fields: [{ name: "cond", kind: "text", placeholder: "x > 0", default: "x > 0", width: 140 }],
      },
      {
        id: "if.compare",
        label: "Compare values",
        category: "conditions",
        description: "Equal, greater, less…",
        template: "{a} {op} {b}",
        fields: [
          { name: "a", kind: "text", placeholder: "a", default: "a", width: 60 },
          { name: "op", kind: "select", options: ["==", "!=", ">", "<", ">=", "<="], default: "==", width: 64 },
          { name: "b", kind: "text", placeholder: "b", default: "b", width: 60 },
        ],
      },
    ],
  },
  {
    id: "loops",
    name: "Loops",
    icon: Repeat,
    color: "loop",
    blocks: [
      {
        id: "loop.for",
        label: "For each item",
        category: "loops",
        description: "Iterate a list",
        template: "for {item} in {list}",
        fields: [
          { name: "item", kind: "text", placeholder: "item", default: "item", width: 80 },
          { name: "list", kind: "text", placeholder: "items", default: "items", width: 80 },
        ],
      },
      {
        id: "loop.while",
        label: "While condition",
        category: "loops",
        description: "Repeat while true",
        template: "while {cond}",
        fields: [{ name: "cond", kind: "text", placeholder: "running", default: "running", width: 140 }],
      },
    ],
  },
  {
    id: "connectors",
    name: "Connectors",
    icon: CircleDot,
    color: "connector",
    blocks: [
      {
        id: "flow.connector",
        label: "Connector",
        category: "connector",
        description: "Jump / merge point — links branches or a loop's exit to what runs next",
        template: "•",
      },
    ],
  },
  {
    id: "functions",
    name: "Functions",
    icon: FunctionSquare,
    color: "function",
    blocks: [
      {
        id: "fn.start",
        label: "Function Start",
        category: "functions",
        description: "Entry point of a function's body — only used inside the Function Editor",
        template: "Start",
        contexts: ["function"],
      },
      {
        id: "fn.return",
        label: "Return",
        category: "functions",
        description: "Return a value from the function",
        template: "return {value}",
        fields: [{ name: "value", kind: "text", placeholder: "result", default: "", width: 120 }],
        contexts: ["function"],
      },
      {
        id: "fn.call",
        label: "Call function",
        category: "functions",
        description: "Invoke a saved function",
        contexts: ["project", "function"],
        // No static template/fields — the editor renders this block
        // specially as a function picker whose inline fields are
        // generated dynamically from whichever function is selected
        // (see values.__functionId in PlacedBlock).
      },
    ],
  },
  {
    id: "files",
    name: "Files",
    icon: FileText,
    color: "file",
    blocks: [
      {
        id: "file.read",
        label: "Read file",
        category: "files",
        description: "Load a file's contents",
        template: "read {path} → {var}",
        fields: [
          { name: "path", kind: "text", placeholder: "data.txt", default: "data.txt", width: 120 },
          { name: "var", kind: "text", placeholder: "data", default: "data", width: 70 },
        ],
      },
      {
        id: "file.write",
        label: "Write file",
        category: "files",
        description: "Save data to a file",
        template: "write {var} → {path}",
        fields: [
          { name: "var", kind: "text", placeholder: "data", default: "data", width: 70 },
          { name: "path", kind: "text", placeholder: "out.txt", default: "out.txt", width: 120 },
        ],
      },
    ],
  },
  {
    id: "apis",
    name: "APIs",
    icon: Cloud,
    color: "api",
    blocks: [
      {
        id: "api.get",
        label: "HTTP GET request",
        category: "apis",
        description: "Fetch data from a URL",
        template: "GET {url} → {var}",
        fields: [
          { name: "url", kind: "text", placeholder: "https://api…", default: "https://api.example.com", width: 180 },
          { name: "var", kind: "text", placeholder: "response", default: "response", width: 80 },
        ],
      },
      {
        id: "api.post",
        label: "HTTP POST request",
        category: "apis",
        description: "Send data to a URL",
        template: "POST {url} body {body}",
        fields: [
          { name: "url", kind: "text", placeholder: "https://api…", default: "https://api.example.com", width: 180 },
          { name: "body", kind: "text", placeholder: "{}", default: "{}", width: 80 },
        ],
      },
    ],
  },
  {
    id: "ai",
    name: "AI Blocks",
    icon: Sparkles,
    color: "ai",
    blocks: [
      {
        id: "ai.chat",
        label: "Chat completion",
        category: "ai",
        description: "Prompt an AI model",
        template: "AI chat {prompt} → {var}",
        fields: [
          { name: "prompt", kind: "text", placeholder: "Hello", default: "Hello", width: 160 },
          { name: "var", kind: "text", placeholder: "reply", default: "reply", width: 70 },
        ],
      },
      {
        id: "ai.classify",
        label: "Classify text",
        category: "ai",
        description: "Assign a label to text",
        template: "classify {text} → {var}",
        fields: [
          { name: "text", kind: "text", placeholder: "input", default: "input", width: 140 },
          { name: "var", kind: "text", placeholder: "label", default: "label", width: 70 },
        ],
      },
      {
        id: "ai.image",
        label: "Generate image",
        category: "ai",
        description: "Create an image from text",
        template: "image of {prompt} → {var}",
        fields: [
          { name: "prompt", kind: "text", placeholder: "A sunset…", default: "A sunset over mountains", width: 180 },
          { name: "var", kind: "text", placeholder: "image", default: "image", width: 70 },
        ],
      },
    ],
  },
  {
    id: "data",
    name: "Data",
    icon: Database,
    color: "data",
    blocks: [
      {
        id: "data.list",
        label: "Create list",
        category: "data",
        description: "Build a list of items",
        template: "list {name} = [{items}]",
        fields: [
          { name: "name", kind: "text", placeholder: "items", default: "items", width: 80 },
          { name: "items", kind: "text", placeholder: "1, 2, 3", default: "1, 2, 3", width: 120 },
        ],
      },
      {
        id: "data.dict",
        label: "Create dictionary",
        category: "data",
        description: "Key-value collection",
        template: "dict {name} = {{pairs}}",
        fields: [
          { name: "name", kind: "text", placeholder: "config", default: "config", width: 80 },
          { name: "pairs", kind: "text", placeholder: "\"a\": 1", default: "\"a\": 1", width: 140 },
        ],
      },
      {
        id: "data.transform",
        label: "Transform data",
        category: "data",
        description: "Map, filter, reduce",
        template: "{op} {list}",
        fields: [
          { name: "op", kind: "select", options: ["map", "filter", "reduce"], default: "map", width: 80 },
          { name: "list", kind: "text", placeholder: "items", default: "items", width: 100 },
        ],
      },
    ],
  },
];

export const CATEGORY_ICON = Boxes;

export function getBlockDef(id: string): BlockDef | undefined {
  for (const c of BLOCK_CATEGORIES) {
    const b = c.blocks.find((x) => x.id === id);
    if (b) return b;
  }
  return undefined;
}