from typing import List, Literal, Optional
from pydantic import BaseModel, Field

# خانات ثابتة للسبورة البيضاء حتى النموذج الرخيص ما يركب الكلام فوق بعضه
WhiteboardSlot = Literal[
    "header",          # العنوان الرئيسي أعلى السبورة
    "main_top",        # المساحة العلوية الكاملة (للمعادلات أو الفكرة الأساسية)
    "left_col",        # العمود الأيسر (السبب / المدخلات / الكود)
    "right_col",       # العمود الأيمن (النتيجة / المخرجات / الشرح)
    "bottom_summary",  # الشريط السفلي (الخلاصة أو التعقيد الزمني Big-O)
    "full_canvas"      # الشاشة كاملة (للكود الطويل أو المخططات الكبيرة)
]

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
        "wb_flow_card"     # رسم بطاقة مخطط انسيابي (طبي أو خوارزمي)
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

    text: Optional[str] = Field(
        default=None,
        description="Text, LaTeX equation, or raw source code."
    )

    code_lang: Optional[Literal["python", "cpp", "java", "r", "sql", "pseudocode"]] = None
    highlight_lines: Optional[List[int]] = Field(
        default=None,
        description="1-based line numbers to highlight inside wb_code."
    )

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