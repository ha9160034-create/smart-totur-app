export type WhiteboardSlot =
  | "header"
  | "main_top"
  | "left_col"
  | "right_col"
  | "bottom_summary"
  | "full_canvas";

export type SketchIcon =
  | "lightbulb"
  | "brain"
  | "check"
  | "warning"
  | "code"
  | "compare";

export type DiagramNodeKind = "container" | "box" | "pill" | "decision";

export type DiagramTint = "blue" | "teal" | "amber" | "rose" | "slate";

export interface DiagramNode {
  id: string;
  label: string;
  sublabel?: string | null;
  kind?: DiagramNodeKind;
  parent_id?: string | null;
  x: number; // 0-1000
  y: number; // 0-1000
  w: number; // 40-1000
  h: number; // 40-1000
  tint?: DiagramTint | null;
}

export interface DiagramEdge {
  from_id: string;
  to_id: string;
  label?: string | null;
  dashed?: boolean;
}

export interface WordTiming {
  word: string;
  start_ms: number;
  duration_ms: number;
}

export interface BoundingBox {
  ymin: number; // 0-1000
  xmin: number; // 0-1000
  ymax: number; // 0-1000
  xmax: number; // 0-1000
}

export interface VisualAction {
  type:
    | "clear_board"
    | "pdf_highlight"
    | "pdf_circle"
    | "wb_heading"
    | "wb_bullet"
    | "wb_equation"
    | "wb_code"
    | "wb_flow_card"
    | "wb_table"
    | "wb_note"
    | "wb_diagram";
  color: "blue" | "red" | "green" | "yellow" | "black";
  bbox?: BoundingBox;
  slot?: WhiteboardSlot;
  connect_from_slot?: WhiteboardSlot;
  icon?: SketchIcon;
  text?: string;
  code?: string;
  code_lang?: "python" | "cpp" | "java" | "r" | "sql" | "pseudocode";
  highlight_lines?: number[];
  headers?: string[];
  rows?: string[][];
  diagram_title?: string | null;
  diagram_aspect?: number | null;
  nodes?: DiagramNode[] | null;
  edges?: DiagramEdge[] | null;
}

export interface TeachingStep {
  step_id: number;
  mode: "whiteboard" | "pdf_overlay";
  speech_ar: string;
  en_terms: string[];
  actions: VisualAction[];
}

export interface LecturePlan {
  title: string;
  subject: "medical" | "programming" | "bioinformatics" | "general";
  needs_deep_reasoning: boolean;
  steps: TeachingStep[];
  quiz_question_ar: string;
}

export interface ExplainSlideResponse {
  plan: LecturePlan;
  slide_image_data_uri: string;
  slide_width: number;
  slide_height: number;
  page_number: number;
  total_pages: number;
}

