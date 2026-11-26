import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { SmartBoardCanvas } from "./src/components/SmartBoardCanvas";
import type {
  ExplainSlideResponse,
  TeachingStep,
  WordTiming,
} from "./src/types/schema";

// ---------------------------------------------------------------------------
// Configuration: Env-driven for Cloud Deployment (Render/Railway), with LAN fallback
// ---------------------------------------------------------------------------
const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL || "http://192.168.0.138:8000"
).replace(/\/+$/, "");
const APP_API_KEY = (process.env.EXPO_PUBLIC_APP_API_KEY || "").trim();
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
  word_timings?: WordTiming[];
}

interface ExplainSlideWithAudioResponse extends ExplainSlideResponse {
  step_audio?: StepAudioPayload[];
  cached?: boolean;
  lecture_id?: string | null;
}

interface CachedPageSummary {
  page_number: number;
  board_mode: BoardMode;
  use_deep_model: boolean;
  title?: string | null;
  created_at?: string | null;
}

interface LectureSummary {
  id: string;
  title: string;
  total_pages: number;
  created_at?: string | null;
  cached_page_numbers: number[];
  cached_pages: CachedPageSummary[];
}

interface RecentLecturesResponse {
  lectures: LectureSummary[];
  supabase_configured: boolean;
}

const BOARD_MODE_CYCLE: BoardMode[] = ["auto", "whiteboard", "pdf_overlay"];

const BOARD_MODE_SHORT_LABELS: Record<BoardMode, string> = {
  auto: "AUTO",
  whiteboard: "WB",
  pdf_overlay: "PDF",
};

const PLAYBACK_SPEEDS: PlaybackSpeed[] = [1.0, 1.25, 1.5];

/**
 * Wrap embedded English phrases with Unicode Left-to-Right Isolate markers (\u2066...\u2069)
 * so multi-word English technical terms read cleanly left-to-right inside RTL Arabic captions.
 */
function formatBidiArabicCaption(text: string): string {
  if (!text) return "";
  return text.replace(
    /[A-Za-z][A-Za-z0-9_/\-+.]*(?:\s+[A-Za-z0-9][A-Za-z0-9_/\-+.]*)*/g,
    (match) => `\u2066${match}\u2069`
  );
}

function requestJson<T>(
  url: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("Accept", "application/json");
    if (APP_API_KEY) {
      xhr.setRequestHeader("X-App-Key", APP_API_KEY);
    }

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
        resolve(payload as T);
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
          `Request timed out after ${timeoutMs / 1000}s. Verify API_BASE_URL (${API_BASE_URL}) and Wi-Fi firewall.`
        )
      );
    };

    xhr.onabort = () => {
      reject(new Error("Request was aborted."));
    };

    xhr.send();
  });
}

function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    if (APP_API_KEY) {
      xhr.setRequestHeader("X-App-Key", APP_API_KEY);
    }

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
        resolve(payload as T);
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
          `Network request failed. Verify API_BASE_URL (${API_BASE_URL}) and connection.`
        )
      );
    };

    xhr.ontimeout = () => {
      reject(
        new Error(
          `Request timed out after ${timeoutMs / 1000}s. Verify API_BASE_URL (${API_BASE_URL}) and server status.`
        )
      );
    };

    xhr.onabort = () => {
      reject(new Error("Request was aborted."));
    };

    xhr.send(JSON.stringify(body));
  });
}

function TutorWorkspace() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isTablet = width >= 600;
  const hudMaxWidth = isTablet ? 640 : undefined;

  const [pdfFile, setPdfFile] = useState<PickedPdf | null>(null);
  const [pageInput, setPageInput] = useState<string>("1");
  const [boardMode, setBoardMode] = useState<BoardMode>("auto");
  const [useDeepModel, setUseDeepModel] = useState<boolean>(false);
  const [showCaptions, setShowCaptions] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExplainSlideWithAudioResponse | null>(
    null
  );
  const [stepIndex, setStepIndex] = useState<number>(0);

  // Recent Lectures Modal State (Supabase persistence)
  const [recentModalVisible, setRecentModalVisible] = useState<boolean>(false);
  const [recentLoading, setRecentLoading] = useState<boolean>(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentLectures, setRecentLectures] = useState<LectureSummary[]>([]);
  const [supabaseConfigured, setSupabaseConfigured] = useState<boolean>(true);

  // Interactive Slide Q&A ("Ask the Professor") State
  const [askExpanded, setAskExpanded] = useState<boolean>(false);
  const [askInput, setAskInput] = useState<string>("");
  const [askLoading, setAskLoading] = useState<boolean>(false);

  // Audio-Visual Sync Engine State (expo-audio at 50ms update cadence for smooth progressive drawing)
  const player = useAudioPlayer(null, { updateInterval: 50 });
  const status = useAudioPlayerStatus(player);
  const [stepAudioUris, setStepAudioUris] = useState<Array<string | null>>([]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1.0);
  const [replayToken, setReplayToken] = useState<number>(0);

  // Atomic locks: prevent stale didJustFinish skipping & keep iOS AVPlayer auto-playing across steps
  const advancedFromStepRef = useRef<number | null>(null);
  const shouldAutoPlayRef = useRef<boolean>(false);
  const playbackSpeedRef = useRef<PlaybackSpeed>(1.0);
  const cacheSessionRef = useRef<number>(0);

  const steps = result?.plan.steps ?? [];
  const currentStep = steps[stepIndex] ?? null;
  const currentStepAudioUri = stepAudioUris[stepIndex] ?? null;

  const currentStepWordTimings = useMemo<WordTiming[]>(() => {
    if (!result?.step_audio || !currentStep) return [];
    const byIndex = result.step_audio[stepIndex];
    if (
      byIndex &&
      byIndex.step_id === currentStep.step_id &&
      Array.isArray(byIndex.word_timings)
    ) {
      return byIndex.word_timings;
    }
    const byStepId = result.step_audio.find(
      (item) => item.step_id === currentStep.step_id
    );
    if (byStepId && Array.isArray(byStepId.word_timings)) {
      return byStepId.word_timings;
    }
    return Array.isArray(byIndex?.word_timings) ? byIndex.word_timings : [];
  }, [result, currentStep, stepIndex]);

  const slideAspectRatio = useMemo(() => {
    if (!result || result.slide_height <= 0) return 16 / 9;
    return result.slide_width / result.slide_height;
  }, [result]);

  // Normalized 0..1 audio progress driving live progressive board drawing & typewriter reveal
  const stepProgress = useMemo(() => {
    if (!result || !currentStep) return 1;
    if (!currentStepAudioUri) return 1;
    // Prevent 1-frame flash at 1.0 when transitioning into a new step before AVPlayer resets didJustFinish
    if (
      advancedFromStepRef.current === stepIndex &&
      isPlaying &&
      !status.playing
    ) {
      return 0;
    }
    if (status.didJustFinish) {
      return 1;
    }
    if (status.duration > 0) {
      const ratio = status.currentTime / status.duration;
      if (!status.playing && !isPlaying && ratio >= 0.98) {
        return 1;
      }
      return Math.max(0, Math.min(1, ratio));
    }
    return 0;
  }, [
    result,
    currentStep,
    currentStepAudioUri,
    stepIndex,
    isPlaying,
    status.currentTime,
    status.duration,
    status.playing,
    status.didJustFinish,
  ]);

  // Unified continuous lecture progress across all steps (0.0 -> 1.0)
  const overallProgress =
    steps.length > 0
      ? Math.max(0, Math.min(1, (stepIndex + stepProgress) / steps.length))
      : 0;

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
      setIsPlaying(false);
      return;
    }

    try {
      player.replace({ uri: currentStepAudioUri });
      player.setPlaybackRate(playbackSpeedRef.current);
      if (shouldAutoPlayRef.current) {
        setIsPlaying(true);
        player.play();
      } else {
        setIsPlaying(false);
      }
    } catch (err) {
      console.warn("Step audio playback error:", err);
      setIsPlaying(false);
    }
  }, [result, stepIndex, currentStep, currentStepAudioUri, player]);

  // Ensure iOS AVPlayer reliably starts playing once the replaced step finishes loading
  useEffect(() => {
    if (status.playing) {
      setIsPlaying(true);
      if (!status.didJustFinish) {
        advancedFromStepRef.current = null;
      }
      return;
    }

    if (
      shouldAutoPlayRef.current &&
      currentStepAudioUri &&
      status.isLoaded &&
      !status.didJustFinish
    ) {
      try {
        player.setPlaybackRate(playbackSpeedRef.current);
        player.play();
        setIsPlaying(true);
      } catch (err) {
        console.warn("Auto-play on isLoaded failed:", err);
      }
      return;
    }

    if (!shouldAutoPlayRef.current) {
      setIsPlaying(false);
    }
  }, [
    status.isLoaded,
    status.playing,
    status.didJustFinish,
    currentStepAudioUri,
    player,
  ]);

  // Watch status.didJustFinish to advance strictly once per completed TeachingStep
  useEffect(() => {
    if (!result || steps.length === 0) return;
    if (!status.didJustFinish) return;
    if (advancedFromStepRef.current !== null) return;

    // Atomically lock this step so subsequent re-renders cannot double-advance
    advancedFromStepRef.current = stepIndex;

    if (stepIndex < steps.length - 1) {
      // Keep auto-play armed across step transitions
      shouldAutoPlayRef.current = true;
      setIsPlaying(true);
      setStepIndex((prev) =>
        prev === stepIndex && prev < steps.length - 1 ? prev + 1 : prev
      );
    } else {
      // Final step finished naturally
      shouldAutoPlayRef.current = false;
      setIsPlaying(false);
    }
  }, [result, status.didJustFinish, stepIndex, steps.length]);

  const handleTogglePlayPause = () => {
    if (!currentStepAudioUri) return;

    try {
      if (isPlaying || status.playing) {
        shouldAutoPlayRef.current = false;
        setIsPlaying(false);
        player.pause();
      } else {
        shouldAutoPlayRef.current = true;
        setIsPlaying(true);
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
      shouldAutoPlayRef.current = true;
      setIsPlaying(true);
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
    // Preserve continuous playback if user taps Next/Prev while playing
    if (isPlaying || status.playing) {
      shouldAutoPlayRef.current = true;
    }
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

  const handleCycleBoardMode = () => {
    const idx = BOARD_MODE_CYCLE.indexOf(boardMode);
    setBoardMode(BOARD_MODE_CYCLE[(idx + 1) % BOARD_MODE_CYCLE.length]);
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

  const preCacheStepAudios = async (
    targetSteps: TeachingStep[],
    audioPayloads?: StepAudioPayload[]
  ): Promise<Array<string | null>> => {
    const cacheSessionId = ++cacheSessionRef.current;
    const batchTs = Date.now();
    const cacheDir = FileSystem.cacheDirectory;

    return Promise.all(
      targetSteps.map(async (step, idx): Promise<string | null> => {
        if (!cacheDir) return null;
        const byIndex = audioPayloads?.[idx];
        const rawBase64 =
          byIndex?.audio_base64 ??
          audioPayloads?.find((item) => item.step_id === step.step_id)
            ?.audio_base64 ??
          null;
        if (!rawBase64) return null;

        try {
          const cleanBase64 = rawBase64.includes("base64,")
            ? rawBase64.split("base64,")[1]
            : rawBase64;
          // Unique timestamped filename prevents iOS AVPlayer from playing stale cached audio
          const fileUri = `${cacheDir}step_${step.step_id}_${idx}_${cacheSessionId}_${batchTs}.mp3`;
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
  };

  const activateSlideResponse = async (data: ExplainSlideWithAudioResponse) => {
    if (!data.plan?.steps?.length) {
      throw new Error("Server returned a LecturePlan with zero steps.");
    }

    const cachedUris = await preCacheStepAudios(
      data.plan.steps,
      data.step_audio
    );

    setAskExpanded(false);
    setAskInput("");
    shouldAutoPlayRef.current = true;
    advancedFromStepRef.current = 0;
    setIsPlaying(Boolean(cachedUris[0]));
    setStepAudioUris(cachedUris);
    setResult(data);
    setStepIndex(0);
    setReplayToken((t) => t + 1);
  };

  const handleAskQuestion = async () => {
    if (!result || askLoading) return;
    const cleanedQuestion = askInput.trim();
    if (!cleanedQuestion) return;

    Keyboard.dismiss();
    setAskLoading(true);
    setError(null);

    // Pause active narration while fetching the professor's answer
    shouldAutoPlayRef.current = false;
    setIsPlaying(false);
    try {
      player.pause();
    } catch {
      // Ignore if idle
    }

    try {
      const existingSteps = result.plan.steps;
      const contextLines = [
        `Slide Title: ${result.plan.title}`,
        ...existingSteps
          .slice(-6)
          .map((s) => `Step ${s.step_id}: ${s.speech_ar}`),
      ];
      const currentPlanContext = contextLines.join("\n").slice(0, 1800);

      const qaData = await postJson<ExplainSlideWithAudioResponse>(
        `${API_BASE_URL}/api/ask`,
        {
          lecture_id: result.lecture_id ?? null,
          page_number: result.page_number,
          question: cleanedQuestion,
          board_mode: boardMode,
          current_plan_context: currentPlanContext,
        },
        REQUEST_TIMEOUT_MS
      );

      if (!qaData.plan?.steps?.length) {
        throw new Error("Server returned an empty Q&A explanation.");
      }

      // Renumber incoming Q&A step_ids sequentially after existing steps for clean canvas keys
      const startIndex = existingSteps.length;
      const renumberedSteps: TeachingStep[] = qaData.plan.steps.map(
        (step, idx) => ({
          ...step,
          step_id: startIndex + idx + 1,
        })
      );
      const alignedAudioPayloads: StepAudioPayload[] = renumberedSteps.map(
        (step, idx) => {
          const originalStep = qaData.plan.steps[idx];
          const matchedAudio =
            qaData.step_audio?.[idx] ??
            qaData.step_audio?.find(
              (item) => item.step_id === originalStep?.step_id
            );
          return {
            step_id: step.step_id,
            audio_base64: matchedAudio?.audio_base64 ?? null,
            word_timings: Array.isArray(matchedAudio?.word_timings)
              ? matchedAudio.word_timings
              : [],
          };
        }
      );

      const newCachedUris = await preCacheStepAudios(
        renumberedSteps,
        alignedAudioPayloads
      );

      setAskInput("");
      setAskExpanded(false);
      shouldAutoPlayRef.current = true;
      advancedFromStepRef.current = startIndex;
      setIsPlaying(Boolean(newCachedUris[0]));

      setResult((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          plan: {
            ...prev.plan,
            steps: [...prev.plan.steps, ...renumberedSteps],
            quiz_question_ar:
              qaData.plan.quiz_question_ar || prev.plan.quiz_question_ar,
          },
          step_audio: [
            ...(prev.step_audio ?? []),
            ...alignedAudioPayloads,
          ],
        };
      });
      setStepAudioUris((prev) => [...prev, ...newCachedUris]);
      setStepIndex(startIndex);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to answer question."
      );
    } finally {
      setAskLoading(false);
    }
  };

  const fetchRecentLectures = async () => {
    setRecentLoading(true);
    setRecentError(null);
    try {
      const payload = await requestJson<RecentLecturesResponse>(
        `${API_BASE_URL}/api/lectures`,
        REQUEST_TIMEOUT_MS
      );
      setRecentLectures(payload.lectures ?? []);
      setSupabaseConfigured(payload.supabase_configured ?? false);
    } catch (err) {
      setRecentError(
        err instanceof Error ? err.message : "Failed to load recent lectures."
      );
    } finally {
      setRecentLoading(false);
    }
  };

  const handleOpenRecentLectures = () => {
    setRecentModalVisible(true);
    void fetchRecentLectures();
  };

  const handleSelectCachedPage = async (
    lecture: LectureSummary,
    cachedPage: CachedPageSummary
  ) => {
    setRecentModalVisible(false);
    shouldAutoPlayRef.current = false;
    setIsPlaying(false);
    advancedFromStepRef.current = 0;
    try {
      player.pause();
    } catch {
      // Ignore if idle
    }

    setLoading(true);
    setError(null);
    setPageInput(String(cachedPage.page_number));
    setBoardMode(cachedPage.board_mode);
    setUseDeepModel(cachedPage.use_deep_model);

    try {
      const url =
        `${API_BASE_URL}/api/lectures/${encodeURIComponent(lecture.id)}` +
        `/pages/${cachedPage.page_number}` +
        `?board_mode=${encodeURIComponent(cachedPage.board_mode)}` +
        `&use_deep_model=${String(cachedPage.use_deep_model)}`;
      const data = await requestJson<ExplainSlideWithAudioResponse>(
        url,
        REQUEST_TIMEOUT_MS
      );
      await activateSlideResponse(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load cached lecture page."
      );
    } finally {
      setLoading(false);
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
    shouldAutoPlayRef.current = false;
    setIsPlaying(false);
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
          if (APP_API_KEY) {
            xhr.setRequestHeader("X-App-Key", APP_API_KEY);
          }

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

      await activateSlideResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network request failed.");
    } finally {
      setLoading(false);
    }
  };

  const canGoPrev = stepIndex > 0;
  const canGoNext = stepIndex < steps.length - 1;
  const isLastStep = steps.length > 0 && stepIndex === steps.length - 1;
  const isPdfOverlayActive = currentStep?.mode === "pdf_overlay";

  const topHudInset = insets.top + 62;
  const bottomHudInset =
    insets.bottom +
    (result && currentStep && showCaptions
      ? askExpanded
        ? 236
        : 184
      : askExpanded
        ? 144
        : 118);

  const activeDocLabel = pdfFile
    ? pdfFile.name.replace(/\.pdf$/i, "")
    : result?.plan.title ?? "Pick PDF";

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle={isPdfOverlayActive ? "light-content" : "dark-content"}
      />

      {/* ================================================================= */}
      {/* LAYER 0: 100% Full-Screen Interactive Pan & Zoom Spatial Canvas   */}
      {/* ================================================================= */}
      <View style={styles.canvasFullScreen}>
        {result && currentStep ? (
          <SmartBoardCanvas
            key={`board-${result.page_number}`}
            steps={steps}
            currentStepIndex={stepIndex}
            slideImageUri={result.slide_image_data_uri}
            slideAspectRatio={slideAspectRatio}
            stepProgress={stepProgress}
            currentTimeMs={status.currentTime * 1000}
            wordTimings={currentStepWordTimings}
            isPlaying={isPlaying || status.playing}
            replayToken={replayToken}
            topInset={topHudInset}
            bottomInset={bottomHudInset}
          />
        ) : (
          <View style={styles.emptyPaperStage}>
            <View
              style={[
                styles.welcomeCard,
                { maxWidth: isTablet ? 460 : 380 },
              ]}
            >
              <Text style={styles.welcomeBadge}>SPATIAL AI WHITEBOARD</Text>
              <Text style={styles.welcomeTitle}>AI Smart Whiteboard Tutor</Text>
              <Text style={styles.welcomeSub}>
                Select a lecture PDF or open a cached lecture to explore
                step-by-step explanations on an interactive pan & zoom paper
                canvas.
              </Text>

              <View style={styles.welcomeActions}>
                <Pressable
                  style={styles.welcomePrimaryBtn}
                  onPress={handlePickPdf}
                >
                  <Text style={styles.welcomePrimaryText}>
                    {pdfFile ? "Change Lecture PDF" : "Select Lecture PDF"}
                  </Text>
                </Pressable>

                <Pressable
                  style={styles.welcomeSecondaryBtn}
                  onPress={handleOpenRecentLectures}
                >
                  <Text style={styles.welcomeSecondaryText}>
                    Recent Lectures
                  </Text>
                </Pressable>
              </View>

              {pdfFile && (
                <Text style={styles.welcomeSelectedNote} numberOfLines={1}>
                  Ready: {pdfFile.name} • Page {pageInput || "1"}
                </Text>
              )}
            </View>
          </View>
        )}
      </View>

      {/* ================================================================= */}
      {/* LAYER 1: Top Floating Spatial HUD (box-none passes pan/zoom)      */}
      {/* ================================================================= */}
      <View
        pointerEvents="box-none"
        style={[styles.topHudOuter, { top: insets.top + 8 }]}
      >
        <View
          pointerEvents="box-none"
          style={[
            styles.topHudRow,
            { maxWidth: hudMaxWidth },
          ]}
        >
          {/* Top-Left Subtle Pill: PDF Title + Page Selector + Recent */}
          <View style={styles.topLeftPill}>
            <Pressable style={styles.docChip} onPress={handlePickPdf}>
              <Text style={styles.docChipText} numberOfLines={1}>
                {activeDocLabel}
              </Text>
            </Pressable>

            {result?.cached && (
              <View style={styles.cachedPill}>
                <Text style={styles.cachedPillText}>Cached ⚡</Text>
              </View>
            )}

            <View style={styles.pillDivider} />

            <View style={styles.pageMiniGroup}>
              <Text style={styles.pageMiniPrefix}>P.</Text>
              <TextInput
                value={pageInput}
                onChangeText={setPageInput}
                keyboardType="number-pad"
                maxLength={4}
                style={styles.pageMiniInput}
                placeholder="1"
                placeholderTextColor="#94A3B8"
                returnKeyType="go"
                onSubmitEditing={() => {
                  if (pdfFile && !loading) void handleExplain();
                }}
              />
            </View>

            <View style={styles.pillDivider} />

            <Pressable
              style={styles.recentMiniBtn}
              onPress={handleOpenRecentLectures}
            >
              <Text style={styles.recentMiniText}>Recent</Text>
            </Pressable>
          </View>

          {/* Top-Right Compact Circular Icons: Mode, Deep, Captions */}
          <View style={styles.topRightIcons}>
            <Pressable
              style={[
                styles.circleIconBtn,
                boardMode !== "auto" && styles.circleIconBtnBlue,
              ]}
              onPress={handleCycleBoardMode}
              accessibilityLabel="Toggle board mode"
            >
              <Text
                style={[
                  styles.circleIconLabel,
                  boardMode !== "auto" && styles.circleIconLabelActive,
                ]}
              >
                {BOARD_MODE_SHORT_LABELS[boardMode]}
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.circleIconBtn,
                useDeepModel && styles.circleIconBtnDeep,
              ]}
              onPress={() => setUseDeepModel((v) => !v)}
              accessibilityLabel="Toggle deep reasoning mode"
            >
              <Text
                style={[
                  styles.circleIconSymbol,
                  useDeepModel && styles.circleIconLabelActive,
                ]}
              >
                ✦
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.circleIconBtn,
                showCaptions && styles.circleIconBtnDark,
              ]}
              onPress={() => setShowCaptions((v) => !v)}
              accessibilityLabel="Toggle captions"
            >
              <Text
                style={[
                  styles.circleIconLabel,
                  showCaptions && styles.circleIconLabelActive,
                ]}
              >
                CC
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* Dismissible Floating Error Toast */}
      {error && (
        <View
          pointerEvents="box-none"
          style={[styles.floatingErrorWrap, { top: insets.top + 56 }]}
        >
          <Pressable
            style={[styles.floatingErrorToast, { maxWidth: hudMaxWidth }]}
            onPress={() => setError(null)}
          >
            <Text style={styles.floatingErrorText} numberOfLines={3}>
              {error}
            </Text>
            <Text style={styles.floatingErrorDismiss}>✕</Text>
          </Pressable>
        </View>
      )}

      {/* ================================================================= */}
      {/* LAYER 2: Collapsible Compact Captions Strip (Above Ask + Dock)    */}
      {/* ================================================================= */}
      {result && currentStep && showCaptions && (
        <View
          pointerEvents="box-none"
          style={[
            styles.captionStripWrap,
            { bottom: insets.bottom + (askExpanded ? 132 : 114) },
          ]}
        >
          <View
            style={[
              styles.captionStripCard,
              { maxWidth: hudMaxWidth },
            ]}
          >
            <ScrollView
              style={styles.captionScroll}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.captionSpeechAr}>
                {formatBidiArabicCaption(currentStep.speech_ar)}
              </Text>

              {isLastStep && !!result.plan.quiz_question_ar && (
                <View style={styles.captionQuizRow}>
                  <Text style={styles.captionQuizText}>
                    سؤال تطبيقي: {formatBidiArabicCaption(result.plan.quiz_question_ar)}
                  </Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      )}

      {/* ================================================================= */}
      {/* LAYER 2B: Collapsible "Ask Anything..." Spatial Pill              */}
      {/* ================================================================= */}
      {result && currentStep && !loading && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          pointerEvents="box-none"
          style={[styles.askOverlayWrap, { bottom: insets.bottom + 72 }]}
        >
          <View
            pointerEvents="box-none"
            style={[styles.askOverlayInner, { maxWidth: hudMaxWidth }]}
          >
            {askExpanded ? (
              <View style={styles.askExpandedPill}>
                <TextInput
                  value={askInput}
                  onChangeText={setAskInput}
                  placeholder="Ask anything about this slide..."
                  placeholderTextColor="#94A3B8"
                  style={styles.askTextInput}
                  returnKeyType="send"
                  editable={!askLoading}
                  autoFocus
                  onSubmitEditing={() => void handleAskQuestion()}
                />
                <Pressable
                  style={[
                    styles.askSendBtn,
                    (!askInput.trim() || askLoading) && styles.dockDisabled,
                  ]}
                  onPress={() => void handleAskQuestion()}
                  disabled={!askInput.trim() || askLoading}
                >
                  {askLoading ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.askSendBtnText}>↑</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.askCloseBtn}
                  onPress={() => {
                    Keyboard.dismiss();
                    setAskExpanded(false);
                  }}
                  disabled={askLoading}
                >
                  <Text style={styles.askCloseBtnText}>✕</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={styles.askCollapsedPill}
                onPress={() => setAskExpanded(true)}
              >
                <Text style={styles.askCollapsedText}>✦ Ask anything...</Text>
              </Pressable>
            )}
          </View>
        </KeyboardAvoidingView>
      )}

      {/* ================================================================= */}
      {/* LAYER 3: Bottom Floating Dark Pill Bar (Playback + Upload/Explain)*/}
      {/* ================================================================= */}
      <View
        pointerEvents="box-none"
        style={[styles.bottomDockWrap, { bottom: insets.bottom + 10 }]}
      >
        <View style={[styles.bottomDarkPill, { maxWidth: hudMaxWidth }]}>
          {loading ? (
            <View style={styles.dockLoadingRow}>
              <ActivityIndicator size="small" color="#F8FAFC" />
              <Text style={styles.dockLoadingText}>
                Analyzing & voicing page {pageInput || "1"}...
              </Text>
            </View>
          ) : result && currentStep ? (
            <>
              <Pressable
                style={[styles.dockJumpBtn, !canGoPrev && styles.dockDisabled]}
                onPress={() => canGoPrev && handleSelectStep(stepIndex - 1)}
                disabled={!canGoPrev}
                accessibilityLabel="Previous step"
              >
                <Text style={styles.dockJumpText}>‹</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.dockPlayBtn,
                  !currentStepAudioUri && styles.dockDisabled,
                ]}
                onPress={handleTogglePlayPause}
                disabled={!currentStepAudioUri}
                accessibilityLabel={
                  isPlaying || status.playing ? "Pause lecture" : "Play lecture"
                }
              >
                <Text style={styles.dockPlayText}>
                  {isPlaying || status.playing ? "⏸" : "▶"}
                </Text>
              </Pressable>

              <Pressable
                style={styles.dockIconBtn}
                onPress={handleReplayStep}
                accessibilityLabel="Replay current step"
              >
                <Text style={styles.dockReplayText}>↺</Text>
              </Pressable>

              {/* Unified Continuous Lecture Progress Bar */}
              <View style={styles.dockProgressWrap}>
                <View style={styles.dockProgressTrack}>
                  <View
                    style={[
                      styles.dockProgressFill,
                      { width: `${(overallProgress * 100).toFixed(2)}%` },
                    ]}
                  />
                  {steps.length > 1 &&
                    steps.slice(1).map((step, boundaryIdx) => {
                      const ratio = (boundaryIdx + 1) / steps.length;
                      const isPassed = overallProgress >= ratio;
                      return (
                        <View
                          key={`tick-${step.step_id}-${boundaryIdx}`}
                          pointerEvents="none"
                          style={[
                            styles.dockProgressTick,
                            isPassed && styles.dockProgressTickPassed,
                            { left: `${(ratio * 100).toFixed(2)}%` },
                          ]}
                        />
                      );
                    })}
                </View>
                <Text style={styles.dockProgressMicroLabel} numberOfLines={1}>
                  {isTablet
                    ? `${Math.round(overallProgress * 100)}% • ${stepIndex + 1}/${steps.length}`
                    : `${stepIndex + 1}/${steps.length}`}
                </Text>
              </View>

              <Pressable
                style={[styles.dockJumpBtn, !canGoNext && styles.dockDisabled]}
                onPress={() => canGoNext && handleSelectStep(stepIndex + 1)}
                disabled={!canGoNext}
                accessibilityLabel="Next step"
              >
                <Text style={styles.dockJumpText}>›</Text>
              </Pressable>

              <Pressable
                style={styles.dockSpeedBtn}
                onPress={handleCycleSpeed}
              >
                <Text style={styles.dockSpeedText}>
                  {playbackSpeed.toFixed(playbackSpeed === 1.25 ? 2 : 1)}x
                </Text>
              </Pressable>

              <Pressable
                style={styles.dockPrimaryTrigger}
                onPress={pdfFile ? handleExplain : handlePickPdf}
              >
                <Text style={styles.dockPrimaryTriggerText}>
                  {pdfFile ? "Explain" : "+ PDF"}
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                style={styles.dockAskTrigger}
                onPress={handlePickPdf}
              >
                <Text style={styles.dockAskText} numberOfLines={1}>
                  {pdfFile
                    ? `PDF: ${pdfFile.name}`
                    : "Pick a lecture PDF to begin..."}
                </Text>
              </Pressable>

              <Pressable
                style={[
                  styles.dockPrimaryTrigger,
                  !pdfFile && styles.dockDisabled,
                ]}
                onPress={handleExplain}
                disabled={!pdfFile}
              >
                <Text style={styles.dockPrimaryTriggerText}>Explain Page</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* ================================================================= */}
      {/* Recent Lectures Slide-Up Modal Drawer (Stage 5 Supabase Cache)    */}
      {/* ================================================================= */}
      <Modal
        visible={recentModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setRecentModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Recent Lectures</Text>
              <View style={styles.modalHeaderActions}>
                <Pressable
                  style={styles.modalActionBtn}
                  onPress={() => void fetchRecentLectures()}
                  disabled={recentLoading}
                >
                  <Text style={styles.modalActionText}>↻ Refresh</Text>
                </Pressable>
                <Pressable
                  style={[styles.modalActionBtn, styles.modalCloseBtn]}
                  onPress={() => setRecentModalVisible(false)}
                >
                  <Text style={styles.modalCloseText}>Close</Text>
                </Pressable>
              </View>
            </View>

            {recentLoading ? (
              <View style={styles.modalCenter}>
                <ActivityIndicator size="small" color="#2563EB" />
                <Text style={styles.modalHint}>Loading saved lectures...</Text>
              </View>
            ) : recentError ? (
              <View style={styles.modalErrorBanner}>
                <Text style={styles.modalErrorText}>{recentError}</Text>
              </View>
            ) : !supabaseConfigured ? (
              <View style={styles.modalCenter}>
                <Text style={styles.modalHint}>
                  Supabase persistence is not configured on the backend yet. Add
                  SUPABASE_URL and SUPABASE_KEY to backend/.env.
                </Text>
              </View>
            ) : recentLectures.length === 0 ? (
              <View style={styles.modalCenter}>
                <Text style={styles.modalHint}>
                  No cached lectures yet. Upload a PDF and explain a page to
                  save it here for instant replay.
                </Text>
              </View>
            ) : (
              <ScrollView
                style={styles.modalList}
                contentContainerStyle={styles.modalListContent}
                showsVerticalScrollIndicator={false}
              >
                {recentLectures.map((lecture) => (
                  <View key={lecture.id} style={styles.lectureCard}>
                    <View style={styles.lectureCardHeader}>
                      <Text style={styles.lectureTitle} numberOfLines={2}>
                        {lecture.title}
                      </Text>
                      <Text style={styles.lectureMeta}>
                        {lecture.total_pages} pages
                      </Text>
                    </View>

                    {lecture.cached_pages.length > 0 ? (
                      <View style={styles.cachedChipsWrap}>
                        {lecture.cached_pages.map((cp, idx) => (
                          <Pressable
                            key={`${lecture.id}-${cp.page_number}-${cp.board_mode}-${String(cp.use_deep_model)}-${idx}`}
                            style={styles.cachedChip}
                            onPress={() =>
                              void handleSelectCachedPage(lecture, cp)
                            }
                          >
                            <Text style={styles.cachedChipText}>
                              P.{cp.page_number} •{" "}
                              {BOARD_MODE_SHORT_LABELS[cp.board_mode]}
                              {cp.use_deep_model ? " • Deep" : ""} ⚡
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.noCachedPagesText}>
                        Indexed for RAG — no explained pages cached yet.
                      </Text>
                    )}
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider>
        <TutorWorkspace />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  root: {
    flex: 1,
    backgroundColor: "#FAF8F5",
  },
  canvasFullScreen: {
    flex: 1,
  },
  emptyPaperStage: {
    flex: 1,
    backgroundColor: "#FAF8F5",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  welcomeCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#E7E2D9",
    padding: 22,
    alignItems: "center",
    gap: 10,
    shadowColor: "#1E293B",
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  welcomeBadge: {
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 1.1,
    color: "#0F766E",
    backgroundColor: "#F0FDFA",
    borderWidth: 1,
    borderColor: "#CCFBF1",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
  },
  welcomeTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: "#0F172A",
    textAlign: "center",
  },
  welcomeSub: {
    fontSize: 13.5,
    lineHeight: 20,
    color: "#64748B",
    textAlign: "center",
  },
  welcomeActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
    width: "100%",
  },
  welcomePrimaryBtn: {
    flex: 1,
    backgroundColor: "#18181B",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  welcomePrimaryText: {
    color: "#FAF8F5",
    fontSize: 13,
    fontWeight: "700",
  },
  welcomeSecondaryBtn: {
    flex: 1,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  welcomeSecondaryText: {
    color: "#1E293B",
    fontSize: 13,
    fontWeight: "700",
  },
  welcomeSelectedNote: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: "600",
    color: "#0F766E",
  },

  // Top Floating HUD
  topHudOuter: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 30,
    alignItems: "center",
  },
  topHudRow: {
    width: "100%",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  topLeftPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderWidth: 1,
    borderColor: "#E7E2D9",
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 5,
    gap: 6,
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  docChip: {
    flex: 1,
    minWidth: 50,
  },
  docChipText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#0F172A",
    includeFontPadding: false,
  },
  cachedPill: {
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  cachedPillText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#B45309",
    includeFontPadding: false,
  },
  pillDivider: {
    width: 1,
    height: 16,
    backgroundColor: "#E2E8F0",
  },
  pageMiniGroup: {
    flexDirection: "row",
    alignItems: "center",
  },
  pageMiniPrefix: {
    fontSize: 11.5,
    fontWeight: "700",
    color: "#64748B",
    includeFontPadding: false,
  },
  pageMiniInput: {
    minWidth: 26,
    maxWidth: 38,
    textAlign: "center",
    fontSize: 12.5,
    fontWeight: "800",
    color: "#0F172A",
    paddingVertical: 2,
    paddingHorizontal: 2,
    includeFontPadding: false,
  },
  recentMiniBtn: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  recentMiniText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#15803D",
    includeFontPadding: false,
  },
  topRightIcons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  circleIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderWidth: 1,
    borderColor: "#E7E2D9",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  circleIconBtnBlue: {
    backgroundColor: "#2563EB",
    borderColor: "#1D4ED8",
  },
  circleIconBtnDeep: {
    backgroundColor: "#4F46E5",
    borderColor: "#4338CA",
  },
  circleIconBtnDark: {
    backgroundColor: "#18181B",
    borderColor: "#27272A",
  },
  circleIconLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: "#334155",
    includeFontPadding: false,
  },
  circleIconSymbol: {
    fontSize: 14,
    fontWeight: "700",
    color: "#334155",
    includeFontPadding: false,
  },
  circleIconLabelActive: {
    color: "#FFFFFF",
  },

  // Floating Error Toast
  floatingErrorWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 35,
    alignItems: "center",
  },
  floatingErrorToast: {
    width: "100%",
    alignSelf: "center",
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    shadowColor: "#991B1B",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  floatingErrorText: {
    flex: 1,
    color: "#B91C1C",
    fontSize: 12,
    fontWeight: "600",
    includeFontPadding: false,
  },
  floatingErrorDismiss: {
    color: "#991B1B",
    fontSize: 13,
    fontWeight: "800",
    paddingHorizontal: 4,
    includeFontPadding: false,
  },

  // Collapsible Compact Captions Strip
  captionStripWrap: {
    position: "absolute",
    left: 14,
    right: 14,
    zIndex: 25,
    alignItems: "center",
  },
  captionStripCard: {
    width: "100%",
    alignSelf: "center",
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderWidth: 1,
    borderColor: "#E7E2D9",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxHeight: 92,
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  captionScroll: {
    maxHeight: 74,
  },
  captionSpeechAr: {
    fontSize: 13.5,
    lineHeight: 20,
    color: "#0F172A",
    fontWeight: "600",
    textAlign: "right",
    writingDirection: "rtl",
    includeFontPadding: false,
  },
  captionQuizRow: {
    marginTop: 5,
    paddingTop: 5,
    borderTopWidth: 1,
    borderTopColor: "#DCFCE7",
  },
  captionQuizText: {
    fontSize: 12.5,
    color: "#166534",
    fontWeight: "700",
    textAlign: "right",
    writingDirection: "rtl",
    includeFontPadding: false,
  },

  // Collapsible "Ask Anything..." Spatial Pill
  askOverlayWrap: {
    position: "absolute",
    left: 14,
    right: 14,
    zIndex: 28,
    alignItems: "center",
  },
  askOverlayInner: {
    width: "100%",
    alignSelf: "center",
    alignItems: "flex-start",
  },
  askCollapsedPill: {
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderWidth: 1,
    borderColor: "#E7E2D9",
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
    shadowColor: "#0F172A",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  askCollapsedText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1E293B",
    includeFontPadding: false,
  },
  askExpandedPill: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 999,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 5,
    gap: 6,
    shadowColor: "#0F172A",
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  askTextInput: {
    flex: 1,
    fontSize: 13.5,
    color: "#0F172A",
    paddingVertical: 6,
    includeFontPadding: false,
  },
  askSendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#18181B",
    alignItems: "center",
    justifyContent: "center",
  },
  askSendBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
    includeFontPadding: false,
  },
  askCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  askCloseBtnText: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "800",
    includeFontPadding: false,
  },

  // Bottom Floating Dark Pill Bar
  bottomDockWrap: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 30,
    alignItems: "center",
  },
  bottomDarkPill: {
    width: "100%",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(24, 24, 27, 0.94)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 7,
    gap: 5,
    shadowColor: "#000000",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  dockLoadingRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 6,
  },
  dockLoadingText: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "600",
    includeFontPadding: false,
  },
  dockJumpBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  dockJumpText: {
    color: "#E2E8F0",
    fontSize: 16,
    fontWeight: "700",
    marginTop: -1,
    includeFontPadding: false,
  },
  dockIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  dockReplayText: {
    color: "#E2E8F0",
    fontSize: 14.5,
    fontWeight: "700",
    includeFontPadding: false,
  },
  dockPlayBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#0F766E",
    alignItems: "center",
    justifyContent: "center",
  },
  dockPlayText: {
    color: "#FFFFFF",
    fontSize: 13.5,
    fontWeight: "700",
    includeFontPadding: false,
  },
  dockProgressWrap: {
    flex: 1,
    minWidth: 56,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
    gap: 3,
  },
  dockProgressTrack: {
    width: "100%",
    height: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.14)",
    overflow: "hidden",
    justifyContent: "center",
    position: "relative",
  },
  dockProgressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: "#14B8A6",
  },
  dockProgressTick: {
    position: "absolute",
    top: 1.75,
    width: 2.5,
    height: 2.5,
    borderRadius: 1.25,
    marginLeft: -1.25,
    backgroundColor: "rgba(255, 255, 255, 0.30)",
  },
  dockProgressTickPassed: {
    backgroundColor: "rgba(255, 255, 255, 0.78)",
  },
  dockProgressMicroLabel: {
    color: "rgba(226, 232, 240, 0.72)",
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 0.2,
    includeFontPadding: false,
  },
  dockSpeedBtn: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  dockSpeedText: {
    color: "#93C5FD",
    fontSize: 11.5,
    fontWeight: "800",
    includeFontPadding: false,
  },
  dockAskTrigger: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  dockAskText: {
    color: "#CBD5E1",
    fontSize: 13,
    fontWeight: "500",
    includeFontPadding: false,
  },
  dockPrimaryTrigger: {
    backgroundColor: "#2563EB",
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  dockPrimaryTriggerText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
    includeFontPadding: false,
  },
  dockDisabled: {
    opacity: 0.35,
  },

  // Recent Lectures Modal Drawer
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    maxHeight: "78%",
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
    gap: 12,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    paddingBottom: 10,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0F172A",
  },
  modalHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  modalActionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  modalActionText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1D4ED8",
  },
  modalCloseBtn: {
    backgroundColor: "#F1F5F9",
    borderColor: "#CBD5E1",
  },
  modalCloseText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#334155",
  },
  modalCenter: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
    paddingHorizontal: 16,
    gap: 8,
  },
  modalHint: {
    fontSize: 13,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 20,
  },
  modalErrorBanner: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 8,
    padding: 8,
  },
  modalErrorText: {
    color: "#B91C1C",
    fontSize: 12,
    fontWeight: "500",
  },
  modalList: {
    maxHeight: 440,
  },
  modalListContent: {
    gap: 10,
    paddingBottom: 8,
  },
  lectureCard: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  lectureCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  lectureTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: "#0F172A",
  },
  lectureMeta: {
    fontSize: 11.5,
    fontWeight: "600",
    color: "#64748B",
  },
  cachedChipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  cachedChip: {
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#FCD34D",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  cachedChipText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#92400E",
  },
  noCachedPagesText: {
    fontSize: 12,
    color: "#64748B",
    fontStyle: "italic",
  },
});
