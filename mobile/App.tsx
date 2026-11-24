import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { SmartBoardCanvas } from "./src/components/SmartBoardCanvas";
import type { ExplainSlideResponse } from "./src/types/schema";

// ---------------------------------------------------------------------------
// Configuration: Replace with your machine's LAN IP (run backend with --host 0.0.0.0)
// Android Emulator can use "http://10.0.2.2:8000"
// ---------------------------------------------------------------------------
const API_BASE_URL = "http://YOUR_LOCAL_IP:8000";
const REQUEST_TIMEOUT_MS = 60_000;

type BoardMode = "auto" | "whiteboard" | "pdf_overlay";

interface PickedPdf {
  uri: string;
  name: string;
  mimeType: string;
}

const BOARD_MODES: Array<{ value: BoardMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "pdf_overlay", label: "PDF Overlay" },
  { value: "whiteboard", label: "Whiteboard" },
];

export default function App() {
  const [pdfFile, setPdfFile] = useState<PickedPdf | null>(null);
  const [pageInput, setPageInput] = useState<string>("1");
  const [boardMode, setBoardMode] = useState<BoardMode>("auto");
  const [useDeepModel, setUseDeepModel] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExplainSlideResponse | null>(null);
  const [stepIndex, setStepIndex] = useState<number>(0);

  const steps = result?.plan.steps ?? [];
  const currentStep = steps[stepIndex] ?? null;

  const slideAspectRatio = useMemo(() => {
    if (!result || result.slide_height <= 0) return 16 / 9;
    return result.slide_width / result.slide_height;
  }, [result]);

  const handlePickPdf = async () => {
    setError(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (picked.canceled || !picked.assets || picked.assets.length === 0) {
        return;
      }

      const asset = picked.assets[0];
      setPdfFile({
        uri: asset.uri,
        name: asset.name ?? "lecture.pdf",
        mimeType: asset.mimeType ?? "application/pdf",
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to select PDF file."
      );
    }
  };

  const handleExplain = async () => {
    if (!pdfFile) {
      setError("Please select a lecture PDF first.");
      return;
    }

    const parsedPage = parseInt(pageInput.trim(), 10);
    if (!Number.isFinite(parsedPage) || parsedPage < 1) {
      setError("Enter a valid 1-based page number (e.g. 1, 2, 3).");
      return;
    }

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const formData = new FormData();
      // React Native FormData expects { uri, name, type } for local files
      formData.append("file", {
        uri: pdfFile.uri,
        name: pdfFile.name,
        type: pdfFile.mimeType || "application/pdf",
      } as unknown as Blob);
      formData.append("page_number", String(parsedPage));
      formData.append("board_mode", boardMode);
      formData.append("use_deep_model", String(useDeepModel));

      // IMPORTANT: Do NOT set Content-Type manually; fetch must generate multipart boundary
      const response = await fetch(`${API_BASE_URL}/api/explain`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      const rawText = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw new Error(
          `Unexpected non-JSON response (HTTP ${response.status}): ${rawText.slice(0, 140)}`
        );
      }

      if (!response.ok) {
        const detail =
          typeof payload === "object" &&
          payload !== null &&
          "detail" in payload &&
          typeof (payload as { detail: unknown }).detail === "string"
            ? (payload as { detail: string }).detail
            : `Server error (HTTP ${response.status})`;
        throw new Error(detail);
      }

      const data = payload as ExplainSlideResponse;
      if (!data.plan?.steps?.length) {
        throw new Error("Server returned a LecturePlan with zero steps.");
      }

      setResult(data);
      setStepIndex(0);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError(
          `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Verify API_BASE_URL (${API_BASE_URL}) and Wi-Fi firewall.`
        );
      } else {
        setError(err instanceof Error ? err.message : "Network request failed.");
      }
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  const canGoPrev = stepIndex > 0;
  const canGoNext = stepIndex < steps.length - 1;
  const isLastStep = steps.length > 0 && stepIndex === steps.length - 1;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />

      {/* Top Controls Bar */}
      <View style={styles.controlsCard}>
        <View style={styles.topRow}>
          <Pressable style={styles.pickBtn} onPress={handlePickPdf}>
            <Text style={styles.pickBtnText} numberOfLines={1}>
              {pdfFile ? `PDF: ${pdfFile.name}` : "Select Lecture PDF"}
            </Text>
          </Pressable>

          <View style={styles.pageBox}>
            <Text style={styles.pageLabel}>Page</Text>
            <TextInput
              value={pageInput}
              onChangeText={setPageInput}
              keyboardType="number-pad"
              maxLength={4}
              style={styles.pageInput}
              placeholder="1"
            />
          </View>
        </View>

        {/* Board Mode Selector + Deep Model Toggle */}
        <View style={styles.modeRow}>
          <View style={styles.segmentGroup}>
            {BOARD_MODES.map((m) => {
              const active = boardMode === m.value;
              return (
                <Pressable
                  key={m.value}
                  onPress={() => setBoardMode(m.value)}
                  style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && styles.segmentTextActive,
                    ]}
                  >
                    {m.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.deepToggle}>
            <Text style={styles.deepLabel}>Deep</Text>
            <Switch
              value={useDeepModel}
              onValueChange={setUseDeepModel}
              trackColor={{ false: "#CBD5E1", true: "#93C5FD" }}
              thumbColor={useDeepModel ? "#2563EB" : "#F8FAFC"}
            />
          </View>
        </View>

        <Pressable
          style={[
            styles.explainBtn,
            (!pdfFile || loading) && styles.explainBtnDisabled,
          ]}
          onPress={handleExplain}
          disabled={!pdfFile || loading}
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color="#FFFFFF" />
              <Text style={styles.explainBtnText}>Analyzing slide...</Text>
            </View>
          ) : (
            <Text style={styles.explainBtnText}>Explain Page</Text>
          )}
        </Pressable>

        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </View>

      {/* Main 60fps SmartBoardCanvas Viewport */}
      <View style={styles.canvasWrapper}>
        {result && currentStep ? (
          <>
            <View style={styles.planMetaBar}>
              <Text style={styles.planTitle} numberOfLines={1}>
                {result.plan.title}
              </Text>
              <Text style={styles.modeBadge}>
                {currentStep.mode === "pdf_overlay" ? "PDF OVERLAY" : "WHITEBOARD"}{" "}
                • {stepIndex + 1}/{steps.length}
              </Text>
            </View>

            <View style={styles.canvasStage}>
              <SmartBoardCanvas
                steps={steps}
                currentStepIndex={stepIndex}
                slideImageUri={result.slide_image_data_uri}
                slideAspectRatio={slideAspectRatio}
              />
            </View>
          </>
        ) : (
          <View style={styles.placeholderStage}>
            <Text style={styles.placeholderTitle}>
              AI Smart Whiteboard Test Harness
            </Text>
            <Text style={styles.placeholderSub}>
              Pick a PDF lecture, enter a page number, and tap "Explain Page" to
              verify Skia bbox overlays & 6-slot whiteboard geometry.
            </Text>
          </View>
        )}
      </View>

      {/* Bottom Speech Transcript + Step Navigation */}
      {result && currentStep && (
        <View style={styles.footerCard}>
          <ScrollView
            style={styles.speechScroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.speechAr}>{currentStep.speech_ar}</Text>

            {currentStep.en_terms.length > 0 && (
              <Text style={styles.enTermsText}>
                EN Terms: {currentStep.en_terms.join(" • ")}
              </Text>
            )}

            {isLastStep && !!result.plan.quiz_question_ar && (
              <View style={styles.quizBox}>
                <Text style={styles.quizLabel}>سؤال تطبيقي:</Text>
                <Text style={styles.quizText}>
                  {result.plan.quiz_question_ar}
                </Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.navRow}>
            <Pressable
              style={[styles.navBtn, !canGoPrev && styles.navBtnDisabled]}
              onPress={() => canGoPrev && setStepIndex((i) => i - 1)}
              disabled={!canGoPrev}
            >
              <Text style={styles.navBtnText}>السابق</Text>
            </Pressable>

            <Text style={styles.stepCounter}>
              Step {currentStep.step_id} / {steps.length}
            </Text>

            <Pressable
              style={[
                styles.navBtn,
                styles.navBtnPrimary,
                !canGoNext && styles.navBtnDisabled,
              ]}
              onPress={() => canGoNext && setStepIndex((i) => i + 1)}
              disabled={!canGoNext}
            >
              <Text style={[styles.navBtnText, styles.navBtnPrimaryText]}>
                التالي
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F1F5F9",
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight ?? 12 : 0,
  },
  controlsCard: {
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    gap: 8,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pickBtn: {
    flex: 1,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickBtnText: {
    color: "#1D4ED8",
    fontSize: 13,
    fontWeight: "600",
  },
  pageBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pageLabel: {
    fontSize: 12,
    color: "#475569",
    fontWeight: "600",
  },
  pageInput: {
    width: 42,
    textAlign: "center",
    fontSize: 14,
    fontWeight: "700",
    color: "#0F172A",
    paddingVertical: 4,
  },
  modeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  segmentGroup: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 8,
    padding: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: "center",
  },
  segmentBtnActive: {
    backgroundColor: "#FFFFFF",
  },
  segmentText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#64748B",
  },
  segmentTextActive: {
    color: "#0F172A",
  },
  deepToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  deepLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#334155",
  },
  explainBtn: {
    backgroundColor: "#2563EB",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  explainBtnDisabled: {
    backgroundColor: "#94A3B8",
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  explainBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  errorBanner: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 8,
    padding: 8,
  },
  errorText: {
    color: "#B91C1C",
    fontSize: 12,
    fontWeight: "500",
  },
  canvasWrapper: {
    flex: 1,
    margin: 10,
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    overflow: "hidden",
  },
  planMetaBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#F8FAFC",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    gap: 8,
  },
  planTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
    color: "#0F172A",
  },
  modeBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: "#2563EB",
  },
  canvasStage: {
    flex: 1,
  },
  placeholderStage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  placeholderTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1E293B",
  },
  placeholderSub: {
    fontSize: 13,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 20,
  },
  footerCard: {
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  speechScroll: {
    maxHeight: 125,
  },
  speechAr: {
    fontSize: 15,
    lineHeight: 23,
    color: "#0F172A",
    fontWeight: "600",
    textAlign: "right",
    writingDirection: "rtl",
  },
  enTermsText: {
    marginTop: 6,
    fontSize: 11.5,
    color: "#475569",
    fontWeight: "500",
  },
  quizBox: {
    marginTop: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
  },
  quizLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#166534",
    textAlign: "right",
  },
  quizText: {
    fontSize: 13.5,
    color: "#14532D",
    textAlign: "right",
    writingDirection: "rtl",
    marginTop: 2,
  },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  navBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#E2E8F0",
    minWidth: 96,
    alignItems: "center",
  },
  navBtnPrimary: {
    backgroundColor: "#2563EB",
  },
  navBtnDisabled: {
    opacity: 0.45,
  },
  navBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0F172A",
  },
  navBtnPrimaryText: {
    color: "#FFFFFF",
  },
  stepCounter: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#475569",
  },
});
