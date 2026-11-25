import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { SmartBoardCanvas } from "./src/components/SmartBoardCanvas";
import type { ExplainSlideResponse } from "./src/types/schema";

// ---------------------------------------------------------------------------
// Configuration: Replace with your machine's LAN IP (run backend with --host 0.0.0.0)
// Android Emulator can use "http://10.0.2.2:8000"
// ---------------------------------------------------------------------------
const API_BASE_URL = "http://192.168.0.138:8000";
const REQUEST_TIMEOUT_MS = 90_000;

type BoardMode = "auto" | "whiteboard" | "pdf_overlay";
type PlaybackSpeed = 1.0 | 1.25 | 1.5;

interface PickedPdf {
  uri: string;
  name: string;
  mimeType: string;
}

interface StepAudioPayload {
  step_id: number;
  audio_base64: string | null;
}

interface ExplainSlideWithAudioResponse extends ExplainSlideResponse {
  step_audio?: StepAudioPayload[];
}

const BOARD_MODES: Array<{ value: BoardMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "pdf_overlay", label: "PDF Overlay" },
  { value: "whiteboard", label: "Whiteboard" },
];

const PLAYBACK_SPEEDS: PlaybackSpeed[] = [1.0, 1.25, 1.5];

export default function App() {
  const [pdfFile, setPdfFile] = useState<PickedPdf | null>(null);
  const [pageInput, setPageInput] = useState<string>("1");
  const [boardMode, setBoardMode] = useState<BoardMode>("auto");
  const [useDeepModel, setUseDeepModel] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExplainSlideWithAudioResponse | null>(
    null
  );
  const [stepIndex, setStepIndex] = useState<number>(0);

  // Audio-Visual Sync Engine State (expo-audio)
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [stepAudioUris, setStepAudioUris] = useState<Array<string | null>>([]);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1.0);
  const [replayToken, setReplayToken] = useState<number>(0);

  // Atomic lock: prevents stale status.didJustFinish from advancing a step more than once
  const advancedFromStepRef = useRef<number | null>(null);
  const playbackSpeedRef = useRef<PlaybackSpeed>(1.0);
  const cacheSessionRef = useRef<number>(0);

  const steps = result?.plan.steps ?? [];
  const currentStep = steps[stepIndex] ?? null;
  const currentStepAudioUri = stepAudioUris[stepIndex] ?? null;

  const slideAspectRatio = useMemo(() => {
    if (!result || result.slide_height <= 0) return 16 / 9;
    return result.slide_width / result.slide_height;
  }, [result]);

  // Configure expo-audio session on mount so iOS plays audio even with mute switch on
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {
      // Non-fatal if audio mode configuration is restricted
    });
  }, []);

  // Load and play the pre-cached MP3 URI synchronously whenever stepIndex or result changes
  useEffect(() => {
    // Lock auto-advance for this step until the new track actually starts playing
    advancedFromStepRef.current = stepIndex;

    try {
      player.pause();
    } catch {
      // Ignore if player has no loaded source yet
    }

    if (!result || !currentStep || !currentStepAudioUri) {
      return;
    }

    try {
      player.replace({ uri: currentStepAudioUri });
      player.setPlaybackRate(playbackSpeedRef.current);
      player.play();
    } catch (err) {
      console.warn("Step audio playback error:", err);
    }
  }, [result, stepIndex, currentStep, currentStepAudioUri, player]);

  // Unlock auto-advance ONLY after the active step genuinely starts playing with didJustFinish cleared
  useEffect(() => {
    if (status.playing && !status.didJustFinish) {
      advancedFromStepRef.current = null;
    }
  }, [status.playing, status.didJustFinish]);

  // Watch status.didJustFinish to advance strictly once per completed TeachingStep
  useEffect(() => {
    if (!result || steps.length === 0) return;
    if (!status.didJustFinish) return;
    if (advancedFromStepRef.current !== null) return;

    // Atomically lock this step so subsequent re-renders cannot double-advance
    advancedFromStepRef.current = stepIndex;

    if (stepIndex < steps.length - 1) {
      setStepIndex((prev) =>
        prev === stepIndex && prev < steps.length - 1 ? prev + 1 : prev
      );
    }
  }, [result, status.didJustFinish, stepIndex, steps.length]);

  const handleTogglePlayPause = () => {
    if (!currentStepAudioUri) return;

    try {
      if (status.playing) {
        player.pause();
      } else {
        const atEnd =
          status.didJustFinish ||
          (status.duration > 0 && status.currentTime >= status.duration - 0.15);
        if (atEnd) {
          advancedFromStepRef.current = stepIndex;
          player.seekTo(0);
        }
        player.setPlaybackRate(playbackSpeedRef.current);
        player.play();
      }
    } catch (err) {
      console.warn("Toggle play/pause failed:", err);
    }
  };

  const handleReplayStep = () => {
    if (!result || !currentStep) return;
    advancedFromStepRef.current = stepIndex;
    setReplayToken((t) => t + 1);

    if (currentStepAudioUri) {
      try {
        player.seekTo(0);
        player.setPlaybackRate(playbackSpeedRef.current);
        player.play();
      } catch (err) {
        console.warn("Replay step audio failed:", err);
      }
    }
  };

  const handleSelectStep = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= steps.length) return;
    advancedFromStepRef.current = nextIndex;
    setStepIndex(nextIndex);
  };

  const handleCycleSpeed = () => {
    const idx = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
    const nextSpeed = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
    playbackSpeedRef.current = nextSpeed;
    setPlaybackSpeed(nextSpeed);

    try {
      player.setPlaybackRate(nextSpeed);
    } catch {
      // Speed will apply when the next step loads
    }
  };

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

    const pageNumber = parseInt(pageInput.trim(), 10);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
      setError("Enter a valid 1-based page number (e.g. 1, 2, 3).");
      return;
    }

    // Pause any playing audio and lock auto-advance before fetching the new slide
    advancedFromStepRef.current = 0;
    try {
      player.pause();
    } catch {
      // Ignore if idle
    }

    setLoading(true);
    setError(null);

    try {
      const asset = pdfFile;
      const formData = new FormData();
      formData.append("file", {
        uri: asset.uri,
        name: asset.name ?? "lecture.pdf",
        type: "application/pdf",
      } as any);
      formData.append("page_number", String(pageNumber));
      formData.append("board_mode", boardMode);
      formData.append("use_deep_model", String(useDeepModel));

      const data = await new Promise<ExplainSlideWithAudioResponse>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${API_BASE_URL}/api/explain`);
          xhr.timeout = REQUEST_TIMEOUT_MS;
          // IMPORTANT: Do NOT set Content-Type manually; XHR must generate the multipart boundary
          xhr.setRequestHeader("Accept", "application/json");

          xhr.onload = () => {
            const rawText = xhr.responseText ?? "";
            let payload: unknown;
            try {
              payload = JSON.parse(rawText);
            } catch {
              reject(
                new Error(
                  `Unexpected non-JSON response (HTTP ${xhr.status}): ${rawText.slice(0, 140)}`
                )
              );
              return;
            }

            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(payload as ExplainSlideWithAudioResponse);
              return;
            }

            const detail =
              typeof payload === "object" &&
                payload !== null &&
                "detail" in payload &&
                typeof (payload as { detail: unknown }).detail === "string"
                ? (payload as { detail: string }).detail
                : `Server error (HTTP ${xhr.status})`;
            reject(new Error(detail));
          };

          xhr.onerror = () => {
            reject(
              new Error(
                `Network request failed. Verify API_BASE_URL (${API_BASE_URL}) and Wi-Fi firewall.`
              )
            );
          };

          xhr.ontimeout = () => {
            reject(
              new Error(
                `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Verify API_BASE_URL (${API_BASE_URL}) and Wi-Fi firewall.`
              )
            );
          };

          xhr.onabort = () => {
            reject(new Error("Request was aborted."));
          };

          xhr.send(formData);
        }
      );

      if (!data.plan?.steps?.length) {
        throw new Error("Server returned a LecturePlan with zero steps.");
      }

      // Pre-cache all step MP3 files to FileSystem.cacheDirectory upfront before playback starts
      const cacheSessionId = ++cacheSessionRef.current;
      const cacheDir = FileSystem.cacheDirectory;
      const cachedUris = await Promise.all(
        data.plan.steps.map(async (step, idx): Promise<string | null> => {
          if (!cacheDir) return null;
          const byIndex = data.step_audio?.[idx];
          const rawBase64 =
            byIndex?.audio_base64 ??
            data.step_audio?.find((item) => item.step_id === step.step_id)
              ?.audio_base64 ??
            null;
          if (!rawBase64) return null;

          try {
            const cleanBase64 = rawBase64.includes("base64,")
              ? rawBase64.split("base64,")[1]
              : rawBase64;
            const fileUri = `${cacheDir}slide_${cacheSessionId}_step_${step.step_id}_${idx}.mp3`;
            await FileSystem.writeAsStringAsync(fileUri, cleanBase64, {
              encoding: FileSystem.EncodingType.Base64,
            });
            return fileUri;
          } catch (writeErr) {
            console.warn(
              `Failed to cache audio for step ${step.step_id}:`,
              writeErr
            );
            return null;
          }
        })
      );

      advancedFromStepRef.current = 0;
      setStepAudioUris(cachedUris);
      setResult(data);
      setStepIndex(0);
      setReplayToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network request failed.");
    } finally {
      setLoading(false);
    }
  };

  const canGoPrev = stepIndex > 0;
  const canGoNext = stepIndex < steps.length - 1;
  const isLastStep = steps.length > 0 && stepIndex === steps.length - 1;

  return (
    <SafeAreaProvider>
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
                <Text style={styles.explainBtnText}>
                  Analyzing & voicing slide...
                </Text>
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
                  {currentStep.mode === "pdf_overlay"
                    ? "PDF OVERLAY"
                    : "WHITEBOARD"}{" "}
                  • {stepIndex + 1}/{steps.length}
                </Text>
              </View>

              <View style={styles.canvasStage}>
                <SmartBoardCanvas
                  key={`board-${result.page_number}-${replayToken}`}
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
                AI Smart Whiteboard Tutor
              </Text>
              <Text style={styles.placeholderSub}>
                Pick a PDF lecture, enter a page number, and tap "Explain Page"
                for a thorough 5–8 step explanation with synchronized Iraqi
                voice & Skia whiteboard animations.
              </Text>
            </View>
          )}
        </View>

        {/* Bottom Speech Transcript + Synchronized Audio & Step Controls */}
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

            {/* Audio Sync Transport Controls: Play/Pause, Replay, Speed */}
            <View style={styles.audioBar}>
              <Pressable
                style={[
                  styles.audioBtn,
                  styles.audioPlayBtn,
                  !currentStepAudioUri && styles.navBtnDisabled,
                ]}
                onPress={handleTogglePlayPause}
                disabled={!currentStepAudioUri}
              >
                <Text style={styles.audioPlayBtnText}>
                  {status.playing ? "⏸ Pause" : "▶ Play"}
                </Text>
              </Pressable>

              <Pressable style={styles.audioBtn} onPress={handleReplayStep}>
                <Text style={styles.audioBtnText}>↺ Replay Step</Text>
              </Pressable>

              <Pressable
                style={[styles.audioBtn, styles.speedBtn]}
                onPress={handleCycleSpeed}
              >
                <Text style={styles.speedBtnText}>
                  {playbackSpeed.toFixed(playbackSpeed === 1.25 ? 2 : 1)}x
                </Text>
              </Pressable>
            </View>

            {/* Step Navigation Controls: Previous / Next */}
            <View style={styles.navRow}>
              <Pressable
                style={[styles.navBtn, !canGoPrev && styles.navBtnDisabled]}
                onPress={() => canGoPrev && handleSelectStep(stepIndex - 1)}
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
                onPress={() => canGoNext && handleSelectStep(stepIndex + 1)}
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
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F1F5F9",
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
    gap: 8,
  },
  speechScroll: {
    maxHeight: 115,
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
  audioBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  audioBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#F1F5F9",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    alignItems: "center",
    justifyContent: "center",
  },
  audioPlayBtn: {
    backgroundColor: "#0F766E",
    borderColor: "#0F766E",
  },
  audioPlayBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  audioBtnText: {
    color: "#0F172A",
    fontSize: 12.5,
    fontWeight: "600",
  },
  speedBtn: {
    flex: 0,
    minWidth: 62,
    backgroundColor: "#EFF6FF",
    borderColor: "#BFDBFE",
  },
  speedBtnText: {
    color: "#1D4ED8",
    fontSize: 12.5,
    fontWeight: "700",
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
