export type WhiteboardSlot =
  | "header"
  | "main_top"
  | "left_col"
  | "right_col"
  | "bottom_summary"
  | "full_canvas";

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
    | "wb_flow_card";
  color: "blue" | "red" | "green" | "yellow" | "black";
  bbox?: BoundingBox;
  slot?: WhiteboardSlot;
  connect_from_slot?: WhiteboardSlot;
  text?: string;
  code?: string;
  code_lang?: "python" | "cpp" | "java" | "r" | "sql" | "pseudocode";
  highlight_lines?: number[];
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

