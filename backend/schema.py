from typing import List, Literal, Optional
from pydantic import BaseModel, Field, model_validator

# خانات ثابتة للسبورة البيضاء حتى النموذج الرخيص ما يركب الكلام فوق بعضه
WhiteboardSlot = Literal[
    "header",          # العنوان الرئيسي أعلى السبورة
    "main_top",        # المساحة العلوية الكاملة (للمعادلات أو الفكرة الأساسية)
    "left_col",        # العمود الأيسر (السبب / المدخلات / الكود)
    "right_col",       # العمود الأيمن (النتيجة / المخرجات / الشرح)
    "bottom_summary",  # الشريط السفلي (الخلاصة أو التعقيد الزمني Big-O)
    "full_canvas"      # الشاشة كاملة (للكود الطويل أو المخططات الكبيرة)
]

SketchIcon = Literal["lightbulb", "brain", "check", "warning", "code", "compare"]
DiagramNodeKind = Literal["container", "box", "pill", "decision"]
DiagramTint = Literal["blue", "teal", "amber", "rose", "slate"]


class DiagramNode(BaseModel):
    id: str = Field(..., description="Unique short node identifier (e.g., 'n1', 'outer_box').")
    label: str = Field(..., description="Concise node label (2-5 words).")
    sublabel: Optional[str] = Field(
        default=None,
        description="Optional short subtitle, metric, or detail (2-4 words).",
    )
    kind: DiagramNodeKind = Field(
        default="box",
        description="container=outer dashed grouping box, box=standard node, pill=start/end/tag, decision=branching diamond",
    )
    parent_id: Optional[str] = Field(
        default=None,
        description="Optional id of an enclosing container node when this node sits inside another box.",
    )
    x: int = Field(..., description="Left X coordinate in 0..1000 diagram space.")
    y: int = Field(..., description="Top Y coordinate in 0..1000 diagram space.")
    w: int = Field(..., description="Width in 40..1000 diagram space.")
    h: int = Field(..., description="Height in 40..1000 diagram space.")
    tint: Optional[DiagramTint] = Field(
        default=None,
        description="Optional whiteboard marker tint: blue, teal, amber, rose, or slate.",
    )


class DiagramEdge(BaseModel):
    from_id: str = Field(..., description="Source node id.")
    to_id: str = Field(..., description="Target node id.")
    label: Optional[str] = Field(
        default=None,
        description="Optional concise edge label (e.g., 'Yes', 'No', 'Signal').",
    )
    dashed: bool = Field(
        default=False,
        description="True for feedback loops, weak links, or secondary data paths.",
    )


class BoundingBox(BaseModel):
    ymin: int = Field(..., ge=0, le=1000, description="Top Y (0-1000)")
    xmin: int = Field(..., ge=0, le=1000, description="Left X (0-1000)")
    ymax: int = Field(..., ge=0, le=1000, description="Bottom Y (0-1000)")
    xmax: int = Field(..., ge=0, le=1000, description="Right X (0-1000)")

class VisualAction(BaseModel):
    type: Literal[
        "clear_board",     # مسح السبورة البيضاء لبدء فكرة جديدة
        "pdf_highlight",   # تظليل أصفر/ملون فوق سطر أو فقرة بالملزمة
        "pdf_circle",      # رسم دائرة أو إطار حول رسمة تشريحية أو كلمة بالملزمة
        "wb_heading",      # كتابة عنوان على السبورة
        "wb_bullet",       # كتابة نقطة شرح على السبورة
        "wb_equation",     # كتابة معادلة بصيغة LaTeX
        "wb_code",         # عرض بلوك كود برمجي ملون
        "wb_flow_card",    # رسم بطاقة مخطط انسيابي (طبي أو خوارزمي)
        "wb_table",        # رسم جدول مقارنة منظم على السبورة (2-4 أعمدة)
        "wb_note",         # ملاحظة هامشية سريعة بخط يدوي (قاعدة، تنبيه، نصيحة)
        "wb_diagram"       # إعادة رسم مخطط تفاعلي كامل (صناديق متداخلة، قرارات، أسهم)
    ]

    color: Literal["blue", "red", "green", "yellow", "black"] = Field(
        default="blue",
        description="blue=structure/normal, red=pathology/bug/alert, green=solution/activation, yellow=highlight"
    )

    # يُستخدم حصراً عندما يكون النوع pdf_highlight أو pdf_circle
    bbox: Optional[BoundingBox] = Field(
        default=None,
        description="Required ONLY for pdf_highlight and pdf_circle."
    )

    # يُستخدم حصراً لأوامر السبورة البيضاء (wb_*)
    slot: Optional[WhiteboardSlot] = Field(
        default=None,
        description="Required ONLY for wb_* actions. Places element cleanly without overlap."
    )

    # ميزة ذكية: تخلي الموبايل يرسم سهم أوتوماتيكياً من خانة سابقة إلى الخانة الحالية
    connect_from_slot: Optional[WhiteboardSlot] = Field(
        default=None,
        description="Optional for wb_flow_card: draws an animated arrow from a previous slot to this slot."
    )

    icon: Optional[SketchIcon] = Field(
        default=None,
        description="Optional small hand-drawn icon badge for wb_heading or wb_flow_card."
    )

    code_lang: Optional[Literal["python", "cpp", "java", "r", "sql", "pseudocode"]] = None
    highlight_lines: Optional[List[int]] = Field(
        default=None,
        description="Optional 1-based line numbers (at most 3 lines, e.g. [2, 3]) to highlight inside wb_code."
    )

    text: Optional[str] = Field(
        default=None,
        description="Text, LaTeX equation, card body, or short margin callout (for wb_heading, wb_bullet, wb_equation, wb_flow_card, wb_note)."
    )

    code: Optional[str] = Field(
        default=None,
        description="REQUIRED for wb_code actions: 3 to 8 lines of real, runnable source code separated by newlines (never empty or placeholder)."
    )

    headers: Optional[List[str]] = Field(
        default=None,
        description="REQUIRED for wb_table actions: 2 to 4 concise column header titles."
    )

    rows: Optional[List[List[str]]] = Field(
        default=None,
        description="REQUIRED for wb_table actions: 2 to 5 concise data rows (2-5 words per cell) aligned with headers."
    )

    diagram_title: Optional[str] = Field(
        default=None,
        description="Optional handwritten header title rendered above a wb_diagram."
    )

    diagram_aspect: Optional[float] = Field(
        default=None,
        description="Optional height/width aspect ratio for wb_diagram (clamped 0.65..1.5, default 0.85)."
    )

    nodes: Optional[List[DiagramNode]] = Field(
        default=None,
        description="REQUIRED for wb_diagram actions: 2 to 18 DiagramNode objects positioned in 0..1000 space."
    )

    edges: Optional[List[DiagramEdge]] = Field(
        default=None,
        description="Optional directed DiagramEdge connectors (0 to 24) referencing valid node ids."
    )

    @model_validator(mode="after")
    def validate_action_payload(self) -> "VisualAction":
        if self.type == "wb_code":
            resolved = (self.code or self.text or "").strip()
            if not resolved:
                raise ValueError(
                    "wb_code action must provide non-empty source code in `code` (or `text`)."
                )
            self.code = resolved
            if not (self.text or "").strip():
                self.text = resolved
        elif self.type == "wb_table":
            if not self.headers:
                raise ValueError(
                    "wb_table action must provide 2 to 4 non-empty column headers."
                )
            cleaned_headers = [str(h).strip() for h in self.headers]
            if not (2 <= len(cleaned_headers) <= 4) or any(not h for h in cleaned_headers):
                raise ValueError(
                    "wb_table action must provide between 2 and 4 non-empty headers."
                )
            if not self.rows:
                raise ValueError(
                    "wb_table action must provide at least one non-empty data row."
                )
            col_count = len(cleaned_headers)
            normalized_rows: List[List[str]] = []
            for row in self.rows:
                cells = [("" if cell is None else str(cell).strip()) for cell in row]
                if len(cells) < col_count:
                    cells.extend([""] * (col_count - len(cells)))
                elif len(cells) > col_count:
                    cells = cells[:col_count]
                if not any(cells):
                    raise ValueError(
                        "wb_table rows cannot be completely blank."
                    )
                normalized_rows.append(cells)
            self.headers = cleaned_headers
            self.rows = normalized_rows
        elif self.type == "wb_diagram":
            raw_nodes = self.nodes or []
            cleaned_nodes: List[DiagramNode] = []
            seen_ids: set[str] = set()
            for node in raw_nodes:
                nid = str(node.id or "").strip()
                label = str(node.label or "").strip()
                if not nid or not label or nid in seen_ids:
                    continue
                seen_ids.add(nid)
                cx = max(0, min(960, int(node.x)))
                cy = max(0, min(960, int(node.y)))
                cw = max(40, min(1000 - cx, int(node.w)))
                ch = max(40, min(1000 - cy, int(node.h)))
                sub = str(node.sublabel).strip() if node.sublabel is not None else None
                cleaned_nodes.append(
                    DiagramNode(
                        id=nid,
                        label=label,
                        sublabel=sub or None,
                        kind=node.kind,
                        parent_id=str(node.parent_id).strip() if node.parent_id else None,
                        x=cx,
                        y=cy,
                        w=cw,
                        h=ch,
                        tint=node.tint,
                    )
                )
                if len(cleaned_nodes) >= 18:
                    break

            if len(cleaned_nodes) < 2:
                raise ValueError(
                    "wb_diagram action must provide at least 2 valid nodes with non-empty id and label."
                )

            valid_ids = {n.id for n in cleaned_nodes}
            for node in cleaned_nodes:
                if node.parent_id and (node.parent_id not in valid_ids or node.parent_id == node.id):
                    node.parent_id = None

            cleaned_edges: List[DiagramEdge] = []
            for edge in (self.edges or []):
                src = str(edge.from_id or "").strip()
                dst = str(edge.to_id or "").strip()
                if src in valid_ids and dst in valid_ids and src != dst:
                    elabel = str(edge.label).strip() if edge.label is not None else None
                    cleaned_edges.append(
                        DiagramEdge(
                            from_id=src,
                            to_id=dst,
                            label=elabel or None,
                            dashed=bool(edge.dashed),
                        )
                    )
                    if len(cleaned_edges) >= 24:
                        break

            aspect = 0.85 if self.diagram_aspect is None else float(self.diagram_aspect)
            self.diagram_aspect = max(0.65, min(1.5, aspect))
            if self.diagram_title is not None:
                self.diagram_title = str(self.diagram_title).strip() or None
            self.nodes = cleaned_nodes
            self.edges = cleaned_edges
        return self

class TeachingStep(BaseModel):
    step_id: int = Field(..., ge=1)
    mode: Literal["whiteboard", "pdf_overlay"]
    speech_ar: str = Field(
        ...,
        description="1 to 3 concise sentences in natural Iraqi university Arabic, keeping all medical and programming terms in English."
    )
    en_terms: List[str] = Field(
        default_factory=list,
        description="Exact English technical terms spoken in speech_ar (for accurate bilingual TTS)."
    )
    actions: List[VisualAction] = Field(..., min_length=1)

class LecturePlan(BaseModel):
    title: str
    subject: Literal["medical", "programming", "bioinformatics", "general"]
    needs_deep_reasoning: bool = Field(
        default=False,
        description="True if this slide contains complex multi-step bugs or deep clinical synthesis."
    )
    steps: List[TeachingStep] = Field(..., min_length=1)
    quiz_question_ar: str = Field(
        ...,
        description="One practical application question in Iraqi Arabic at the end of the explanation."
    )


class ExplainSlideResponse(BaseModel):
    """API response envelope pairing the locked LecturePlan with the exact rendered slide image."""
    plan: LecturePlan
    slide_image_data_uri: str = Field(
        ...,
        description="Base64 JPEG data URI (data:image/jpeg;base64,...) of the exact image analyzed by Gemini."
    )
    slide_width: int = Field(..., gt=0, description="Rendered slide width in pixels.")
    slide_height: int = Field(..., gt=0, description="Rendered slide height in pixels.")
    page_number: int = Field(..., ge=1)
    total_pages: int = Field(..., ge=1)

