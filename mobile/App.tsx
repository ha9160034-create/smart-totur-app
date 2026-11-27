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
  Switch,
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
import { useFonts } from "expo-font";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { CircularWheelPagePicker } from "./src/components/CircularWheelPagePicker";
import { SmartBoardCanvas } from "./src/components/SmartBoardCanvas";
import { extractLocalPdfPageCount } from "./src/utils/pdfPageCount";
import type {
  ExplainSlideResponse,
  TeachingStep,
  WordTiming,
} from "./src/types/schema";

// ---------------------------------------------------------------------------
// Configuration: Env-driven with live Railway production fallback (never LAN IP)
// ---------------------------------------------------------------------------
const PRODUCTION_API_URL = "https://smart-totur-app-production.up.railway.app";
const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL || PRODUCTION_API_URL
)
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\/+$/, "");
const APP_API_KEY = (process.env.EXPO_PUBLIC_APP_API_KEY || "")
  .trim()
  .replace(/^["']|["']$/g, "");
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

interface ActiveLectureMeta {
  id: string;
  title: string;
  totalPages: number;
  cachedPages: CachedPageSummary[];
}

interface PdfInfoResponse {
  total_pages: number;
  title: string;
}

/**
 * Lightweight native XMLHttpRequest upload to POST /api/pdf-info (<20ms PyMuPDF check)
 * returning authoritative total_pages even for PDF 1.5+ compressed object streams.
 */
function uploadPdfForInfo(asset: PickedPdf): Promise<PdfInfoResponse | null> {
  return new Promise((resolve) => {
    try {
      const formData = new FormData();
      formData.append("file", {
        uri: asset.uri,
        name: asset.name ?? "lecture.pdf",
        type: "application/pdf",
      } as any);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE_URL}/api/pdf-info`);
      xhr.timeout = 18_000;
      xhr.setRequestHeader("Accept", "application/json");
      if (APP_API_KEY) {
        xhr.setRequestHeader("X-App-Key", APP_API_KEY);
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const parsed = JSON.parse(xhr.responseText ?? "") as PdfInfoResponse;
            if (parsed && typeof parsed.total_pages === "number" && parsed.total_pages >= 1) {
              resolve(parsed);
              return;
            }
          } catch {
            // Fall through to null
          }
        }
        resolve(null);
      };
      xhr.onerror = () => resolve(null);
      xhr.ontimeout = () => resolve(null);
      xhr.onabort = () => resolve(null);
      xhr.send(formData);
    } catch {
      resolve(null);
    }
  });
}

function TutorWorkspace() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isTablet = width >= 600;
  const hudMaxWidth = isTablet ? 640 : undefined;

  // Non-blocking bundled handwritten whiteboard fonts (falls back gracefully to system fonts)
  const [fontsLoaded, fontError] = useFonts({
    "PlaypenSansArabic-Regular": require("./assets/fonts/PlaypenSansArabic-Regular.ttf"),
    "PlaypenSansArabic-SemiBold": require("./assets/fonts/PlaypenSansArabic-SemiBold.ttf"),
    "PatrickHand-Regular": require("./assets/fonts/PatrickHand-Regular.ttf"),
  });
  const handwrittenFontsReady = Boolean(fontsLoaded && !fontError);

  const [pdfFile, setPdfFile] = useState<PickedPdf | null>(null);
  const [activeLectureMeta, setActiveLectureMeta] =
    useState<ActiveLectureMeta | null>(null);
  const [selectedPage, setSelectedPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [boardMode, setBoardMode] = useState<BoardMode>("auto");
  const [useDeepModel, setUseDeepModel] = useState<boolean>(false);
  const [showCaptions, setShowCaptions] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExplainSlideWithAudioResponse | null>(
    null
  );
  const [stepIndex, setStepIndex] = useState<number>(0);

  // Stage 16 Popover & Drawer States
  const [optionsMenuOpen, setOptionsMenuOpen] = useState<boolean>(false);
  const [pageWheelOpen, setPageWheelOpen] = useState<boolean>(false);
  const [recentModalVisible, setRecentModalVisible] = useState<boolean>(false);
  const [recentLoading, setRecentLoading] = useState<boolean>(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentLectures, setRecentLectures] = useState<LectureSummary[]>([]);
  const [supabaseConfigured, setSupabaseConfigured] = useState<boolean>(true);

  // Unified Bottom Chat Dock State (Free Q&A + Slide Q&A + Explain)
  const [chatInput, setChatInput] = useState<string>("");
  const [askLoading, setAskLoading] = useState<boolean>(false);
  const [isFreeMode, setIsFreeMode] = useState<boolean>(true);
  const [freeSearchEnabled, setFreeSearchEnabled] = useState<boolean>(true);

  // Audio-Visual Sync Engine State (expo-audio at 50ms update cadence for smooth progressive drawing)
  const player = useAudioPlayer(null, { updateInterval: 50 });
  const status = useAudioPlayerStatus(player);
  const [stepAudioUris, setStepAudioUris] = useState<Array<string | null>>([]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1.0);
  const [replayToken, setReplayToken] = useState<number>(0);

  // Atomic locks: prevent stale didJustFinish skipping & stale PDF info responses
  const advancedFromStepRef = useRef<number | null>(null);
  const shouldAutoPlayRef = useRef<boolean>(false);
  const playbackSpeedRef = useRef<PlaybackSpeed>(1.0);
  const cacheSessionRef = useRef<number>(0);
  const pdfPickSeqRef = useRef<number>(0);
  // Per-lecture page summary map for seamless cross-page continuity (Page N-1 -> Page N)
  const pageSummariesRef = useRef<Map<number, string>>(new Map());
  // Multi-turn history for standalone Free Q&A whiteboard sessions
  const freeHistoryRef = useRef<Array<{ question: string; summary: string }>>([]);

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
      if (!status.playing && !isPlaying && ratio >= 0.95) {
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

  const handleSelectBoardMode = (mode: BoardMode) => {
    if (!pdfFile && !activeLectureMeta) {
      setBoardMode("whiteboard");
      return;
    }
    setBoardMode(mode);
  };

  const handleClearBoard = () => {
    setOptionsMenuOpen(false);
    setPageWheelOpen(false);
    shouldAutoPlayRef.current = false;
    setIsPlaying(false);
    advancedFromStepRef.current = 0;
    try {
      player.pause();
    } catch {
      // Ignore if idle
    }
    // Refinement #3: Clear canvas drawings, audio state, result & freeHistoryRef
    // while preserving any currently attached PDF chip (pdfFile / activeLectureMeta)
    setResult(null);
    setStepAudioUris([]);
    setStepIndex(0);
    setError(null);
    setChatInput("");
    freeHistoryRef.current = [];
    setIsFreeMode(!pdfFile && !activeLectureMeta);
  };

  const handleDetachPdf = () => {
    pdfPickSeqRef.current += 1;
    setPdfFile(null);
    setActiveLectureMeta(null);
    setTotalPages(null);
    setSelectedPage(1);
    setPageWheelOpen(false);
    setIsFreeMode(true);
    setBoardMode("whiteboard");
  };

  const handlePickPdf = async () => {
    setError(null);
    setOptionsMenuOpen(false);
    setPageWheelOpen(false);
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
      const nextPdf: PickedPdf = {
        uri: asset.uri,
        name: asset.name ?? "lecture.pdf",
        mimeType: asset.mimeType ?? "application/pdf",
      };

      const pickSeq = ++pdfPickSeqRef.current;
      pageSummariesRef.current.clear();
      setPdfFile(nextPdf);
      setActiveLectureMeta(null);
      setIsFreeMode(false);
      setSelectedPage(1);
      setTotalPages(null);

      // Run instant local PDF page estimator + authoritative <20ms PyMuPDF /api/pdf-info in parallel
      let resolvedByServer = false;
      void extractLocalPdfPageCount(nextPdf.uri).then((localCount) => {
        if (pickSeq !== pdfPickSeqRef.current || resolvedByServer) return;
        if (localCount && localCount >= 1) {
          setTotalPages((prev) => prev ?? localCount);
        }
      });

      void uploadPdfForInfo(nextPdf).then((info) => {
        if (pickSeq !== pdfPickSeqRef.current) return;
        if (info && info.total_pages >= 1) {
          resolvedByServer = true;
          setTotalPages(info.total_pages);
        }
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

    // Store a compact summary of this page so the next slide (page N+1) transitions seamlessly
    const summaryParts = [
      `Title: ${data.plan.title}`,
      ...data.plan.steps
        .slice(0, 5)
        .map((s) => s.speech_ar.trim().slice(0, 110))
        .filter((s) => s.length > 0),
    ];
    pageSummariesRef.current.set(
      data.page_number,
      summaryParts.join(" | ").slice(0, 650)
    );

    const stampedInitialData: ExplainSlideWithAudioResponse = {
      ...data,
      plan: {
        ...data.plan,
        steps: data.plan.steps.map((step) => ({
          ...step,
          turnIndex: step.turnIndex ?? 0,
        })),
      },
    };

    const cachedUris = await preCacheStepAudios(
      stampedInitialData.plan.steps,
      stampedInitialData.step_audio
    );

    if (stampedInitialData.total_pages >= 1 && !isFreeMode) {
      setTotalPages(stampedInitialData.total_pages);
      setSelectedPage(stampedInitialData.page_number);
    }

    shouldAutoPlayRef.current = true;
    advancedFromStepRef.current = 0;
    setIsPlaying(Boolean(cachedUris[0]));
    setStepAudioUris(cachedUris);
    setResult(stampedInitialData);
    setStepIndex(0);
    setReplayToken((t) => t + 1);
    return stampedInitialData;
  };

  const handleStartFreeAsk = async (questionText?: string) => {
    if (loading || askLoading) return;
    const cleanedQuestion = (questionText ?? chatInput).trim();
    if (!cleanedQuestion) return;

    Keyboard.dismiss();
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
    setIsFreeMode(true);
    setBoardMode("whiteboard");
    freeHistoryRef.current = [];

    try {
      const data = await postJson<ExplainSlideWithAudioResponse>(
        `${API_BASE_URL}/api/ask-free`,
        {
          question: cleanedQuestion,
          search_sources: freeSearchEnabled,
          history: [],
        },
        REQUEST_TIMEOUT_MS
      );

      if (!data.plan?.steps?.length) {
        throw new Error("Server returned an empty explanation.");
      }

      const turnSummary = [
        data.plan.title,
        ...data.plan.steps.slice(0, 4).map((s) => s.speech_ar.trim().slice(0, 95)),
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 420);
      freeHistoryRef.current = [{ question: cleanedQuestion, summary: turnSummary }];

      setChatInput("");
      await activateSlideResponse(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to answer question."
      );
    } finally {
      setLoading(false);
    }
  };

  const handleAskQuestion = async (
    questionOverride?: string,
    baseResultOverride?: ExplainSlideWithAudioResponse | null,
    targetPageOverride?: number
  ) => {
    const activeResult = baseResultOverride ?? result;
    if (!activeResult || askLoading) return;
    const cleanedQuestion = (questionOverride ?? chatInput).trim();
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
      const existingSteps = activeResult.plan.steps;
      const askFreeSession =
        !baseResultOverride && isFreeMode && !pdfFile && !activeLectureMeta;
      let qaData: ExplainSlideWithAudioResponse;

      if (askFreeSession) {
        qaData = await postJson<ExplainSlideWithAudioResponse>(
          `${API_BASE_URL}/api/ask-free`,
          {
            question: cleanedQuestion,
            search_sources: freeSearchEnabled,
            history: freeHistoryRef.current,
          },
          REQUEST_TIMEOUT_MS
        );
      } else {
        const contextLines = [
          `Slide Title: ${activeResult.plan.title}`,
          ...existingSteps
            .slice(-6)
            .map((s) => `Step ${s.step_id}: ${s.speech_ar}`),
        ];
        const currentPlanContext = contextLines.join("\n").slice(0, 1800);

        qaData = await postJson<ExplainSlideWithAudioResponse>(
          `${API_BASE_URL}/api/ask`,
          {
            lecture_id: activeResult.lecture_id ?? activeLectureMeta?.id ?? null,
            page_number: targetPageOverride ?? activeResult.page_number ?? selectedPage,
            question: cleanedQuestion,
            board_mode: boardMode,
            current_plan_context: currentPlanContext,
          },
          REQUEST_TIMEOUT_MS
        );
      }

      if (!qaData.plan?.steps?.length) {
        throw new Error("Server returned an empty Q&A explanation.");
      }

      if (askFreeSession) {
        const turnSummary = [
          qaData.plan.title,
          ...qaData.plan.steps.slice(0, 3).map((s) => s.speech_ar.trim().slice(0, 95)),
        ]
          .filter(Boolean)
          .join(" | ")
          .slice(0, 420);
        freeHistoryRef.current = [
          ...freeHistoryRef.current.slice(-5),
          { question: cleanedQuestion, summary: turnSummary },
        ];
      }

      // Renumber incoming Q&A step_ids sequentially and stamp chronological turnIndex
      const startIndex = existingSteps.length;
      const nextTurnIndex =
        (existingSteps[existingSteps.length - 1]?.turnIndex ?? 0) + 1;
      const renumberedSteps: TeachingStep[] = qaData.plan.steps.map(
        (step, idx) => ({
          ...step,
          step_id: startIndex + idx + 1,
          turnIndex: nextTurnIndex,
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

      setChatInput("");
      shouldAutoPlayRef.current = true;
      advancedFromStepRef.current = startIndex;
      setIsPlaying(Boolean(newCachedUris[0]));

      setResult((prev) => {
        const base = prev ?? activeResult;
        if (!base) return prev;
        return {
          ...base,
          plan: {
            ...base.plan,
            steps: [...base.plan.steps, ...renumberedSteps],
            quiz_question_ar:
              qaData.plan.quiz_question_ar || base.plan.quiz_question_ar,
            sources: qaData.plan.sources ?? base.plan.sources,
          },
          step_audio: [
            ...(base.step_audio ?? []),
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
    setOptionsMenuOpen(false);
    setPageWheelOpen(false);
    setRecentModalVisible(true);
    void fetchRecentLectures();
  };

  const handleSelectCachedPage = async (
    lecture: LectureSummary,
    cachedPage: CachedPageSummary
  ) => {
    setRecentModalVisible(false);
    setOptionsMenuOpen(false);
    setPageWheelOpen(false);
    shouldAutoPlayRef.current = false;
    setIsPlaying(false);
    advancedFromStepRef.current = 0;
    try {
      player.pause();
    } catch {
      // Ignore if idle
    }

    if (result?.lecture_id && lecture.id !== result.lecture_id) {
      pageSummariesRef.current.clear();
    }

    setPdfFile(null);
    setActiveLectureMeta({
      id: lecture.id,
      title: lecture.title,
      totalPages: Math.max(1, lecture.total_pages || 1),
      cachedPages: lecture.cached_pages ?? [],
    });
    setIsFreeMode(false);
    freeHistoryRef.current = [];
    setLoading(true);
    setError(null);
    setSelectedPage(cachedPage.page_number);
    setTotalPages(Math.max(1, lecture.total_pages || 1));
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

  const handleExplain = async (
    overridePage?: number
  ): Promise<ExplainSlideWithAudioResponse | null> => {
    if (!pdfFile) {
      setError("Please attach a lecture PDF first using +.");
      return null;
    }

    const pageNumber = Math.max(1, Math.floor(overridePage ?? selectedPage));

    // Pause any playing audio and lock auto-advance before fetching the new slide
    shouldAutoPlayRef.current = false;
    setIsPlaying(false);
    advancedFromStepRef.current = 0;
    try {
      player.pause();
    } catch {
      // Ignore if idle
    }

    setIsFreeMode(false);
    freeHistoryRef.current = [];
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
      if (pageNumber > 1) {
        const prevSummary = pageSummariesRef.current.get(pageNumber - 1);
        if (prevSummary) {
          formData.append("prev_page_summary", prevSummary);
        }
      }

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

      const activated = await activateSlideResponse(data);
      return activated;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network request failed.");
      return null;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Unified Smart Send Router (Stage 16 + Refinement #2):
   * - No PDF attached & non-empty text -> /api/ask-free (initial or follow-up)
   * - PDF attached & empty text -> Explain selectedPage (or load cached page)
   * - PDF attached & non-empty text:
   *     * If !result yet (or page changed on local PDF), run handleExplain(selectedPage)
   *       first to initialize lecture/slide context and IMMEDIATELY chain POST /api/ask
   *       with the user's typed question so no prompt is ever dropped!
   */
  const handleUnifiedSend = async () => {
    if (loading || askLoading) return;
    setOptionsMenuOpen(false);
    setPageWheelOpen(false);
    const trimmed = chatInput.trim();
    const attached = Boolean(pdfFile || activeLectureMeta);

    if (!attached) {
      if (!trimmed) return;
      if (!result || !isFreeMode) {
        await handleStartFreeAsk(trimmed);
      } else {
        await handleAskQuestion(trimmed);
      }
      return;
    }

    // PDF or cached lecture attached + EMPTY input -> Explain selectedPage
    if (!trimmed) {
      if (pdfFile) {
        await handleExplain(selectedPage);
        return;
      }
      if (activeLectureMeta) {
        const cachedMatch = activeLectureMeta.cachedPages.find(
          (cp) => cp.page_number === selectedPage
        );
        if (cachedMatch) {
          await handleSelectCachedPage(
            {
              id: activeLectureMeta.id,
              title: activeLectureMeta.title,
              total_pages: activeLectureMeta.totalPages,
              cached_page_numbers: activeLectureMeta.cachedPages.map(
                (p) => p.page_number
              ),
              cached_pages: activeLectureMeta.cachedPages,
            },
            cachedMatch
          );
          return;
        }
        setError(
          `Page ${selectedPage} is not cached yet. Tap + to attach the PDF file to explain it, or type a question.`
        );
      }
      return;
    }

    // PDF or cached lecture attached + NON-EMPTY question
    if (pdfFile) {
      // Refinement #2: Initialize slide/lecture context via handleExplain first when !result
      // (or when switching to a new page), then immediately chain /api/ask with their question
      const needsExplainFirst =
        !result || isFreeMode || result.page_number !== selectedPage;
      if (needsExplainFirst) {
        const explained = await handleExplain(selectedPage);
        if (explained) {
          await handleAskQuestion(trimmed, explained, selectedPage);
        }
        return;
      }
      await handleAskQuestion(trimmed, result, selectedPage);
      return;
    }

    // Cached lecture from Recent + typed question
    if (activeLectureMeta) {
      if (result && !isFreeMode) {
        await handleAskQuestion(trimmed, result, selectedPage);
      } else {
        // Ask directly against the cached lecture's Supabase RAG chunks & page
        Keyboard.dismiss();
        setAskLoading(true);
        setError(null);
        try {
          const qaData = await postJson<ExplainSlideWithAudioResponse>(
            `${API_BASE_URL}/api/ask`,
            {
              lecture_id: activeLectureMeta.id,
              page_number: selectedPage,
              question: trimmed,
              board_mode: boardMode,
              current_plan_context: `Lecture: ${activeLectureMeta.title}, Page ${selectedPage}`,
            },
            REQUEST_TIMEOUT_MS
          );
          setChatInput("");
          await activateSlideResponse(qaData);
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "Failed to answer question."
          );
        } finally {
          setAskLoading(false);
        }
      }
    }
  };

  const canGoPrev = stepIndex > 0;
  const canGoNext = stepIndex < steps.length - 1;
  const isLastStep = steps.length > 0 && stepIndex === steps.length - 1;
  const isPdfOverlayActive = currentStep?.mode === "pdf_overlay";

  const hasAttachedPdf = Boolean(pdfFile || activeLectureMeta);
  const attachedPdfName = pdfFile?.name || activeLectureMeta?.title || "";
  const effectiveTotalPages = Math.max(
    1,
    totalPages ?? activeLectureMeta?.totalPages ?? result?.total_pages ?? 1
  );
  const isBoardModeLocked = !hasAttachedPdf;
  const isBusy = loading || askLoading;
  const canSend = !isBusy && (hasAttachedPdf || chatInput.trim().length > 0);

  const topHudInset = insets.top + 90;
  const activeBottomStackHeight =
    72 + // Unified chat dock
    (hasAttachedPdf ? 42 : 0) + // Dynamic PDF filename + P. X / N chip row
    (result && currentStep ? 48 : 0) + // Slim light playback strip
    (result && currentStep && showCaptions ? 92 : 0); // Captions card
  const bottomHudInset = Math.max(
    insets.bottom + 140,
    insets.bottom + activeBottomStackHeight
  );

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle={isPdfOverlayActive ? "light-content" : "dark-content"}
      />

      {/* ================================================================= */}
      {/* LAYER 0: 100% Full-Screen Clean #FAF8F5 Paper / Spatial Canvas    */}
      {/* ================================================================= */}
      <View style={styles.canvasFullScreen}>
        {result && currentStep ? (
          <SmartBoardCanvas
            key={isFreeMode ? "board-free-qa" : `board-${result.page_number}`}
            steps={steps}
            currentStepIndex={stepIndex}
            slideImageUri={result.slide_image_data_uri}
            slideAspectRatio={slideAspectRatio}
            stepProgress={stepProgress}
            currentTimeMs={status.currentTime * 1000}
            wordTimings={currentStepWordTimings}
            isPlaying={isPlaying || status.playing}
            replayToken={replayToken}
            handwrittenFontsReady={handwrittenFontsReady}
            topInset={topHudInset}
            bottomInset={bottomHudInset}
          />
        ) : (
          <Pressable
            style={styles.emptyCleanPaper}
            onPress={() => {
              Keyboard.dismiss();
              setOptionsMenuOpen(false);
              setPageWheelOpen(false);
            }}
            accessibilityLabel="Open whiteboard paper canvas"
          />
        )}
      </View>

      {/* ================================================================= */}
      {/* LAYER 1: Decluttered 2-Pill Top Header (Recent | Options ▾)       */}
      {/* ================================================================= */}
      <View
        pointerEvents="box-none"
        style={[styles.topHudOuter, { top: insets.top + 10 }]}
      >
        <View
          pointerEvents="box-none"
          style={[styles.topHudRow, { maxWidth: hudMaxWidth }]}
        >
          {/* Top-Left: Single Sleek Recent Pill */}
          <Pressable
            style={styles.headerPillBtn}
            onPress={handleOpenRecentLectures}
            accessibilityLabel="Open recent lectures"
          >
            <Text style={styles.headerPillIcon}>◷</Text>
            <Text style={styles.headerPillText}>Recent</Text>
          </Pressable>

          {/* Top-Right: Single Sleek Options ▾ Pill */}
          <Pressable
            style={[
              styles.headerPillBtn,
              optionsMenuOpen && styles.headerPillBtnActive,
            ]}
            onPress={() => {
              setPageWheelOpen(false);
              setOptionsMenuOpen((v) => !v);
            }}
            accessibilityLabel="Open board options"
          >
            <Text style={styles.headerPillIcon}>☰</Text>
            <Text style={styles.headerPillText}>Options</Text>
            <Text style={styles.headerPillChevron}>
              {optionsMenuOpen ? "▴" : "▾"}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* ================================================================= */}
      {/* LAYER 1B: Floating White Options Popover (Auto-Closes Outside)    */}
      {/* ================================================================= */}
      {optionsMenuOpen && (
        <View style={styles.popoverOverlayRoot} pointerEvents="box-none">
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOptionsMenuOpen(false)}
            accessibilityLabel="Close options menu"
          />
          <View
            pointerEvents="box-none"
            style={[styles.optionsAnchorWrap, { top: insets.top + 54 }]}
          >
            <View style={styles.optionsPopoverCard}>
              {/* Row 1: Board Mode (AUTO | WB | PDF, locked to WB when no PDF loaded) */}
              <View style={styles.optionsRow}>
                <View style={styles.optionsLabelCol}>
                  <Text style={styles.optionsRowLabel}>Board Mode</Text>
                  {isBoardModeLocked && (
                    <Text style={styles.optionsSubHint}>WB locked (No PDF)</Text>
                  )}
                </View>
                <View style={styles.modeSegmentWrap}>
                  {BOARD_MODE_CYCLE.map((mode) => {
                    const effectiveSelected = isBoardModeLocked
                      ? mode === "whiteboard"
                      : boardMode === mode;
                    const disabled = isBoardModeLocked && mode !== "whiteboard";
                    return (
                      <Pressable
                        key={mode}
                        style={[
                          styles.modeSegmentBtn,
                          effectiveSelected && styles.modeSegmentBtnActive,
                          disabled && styles.modeSegmentBtnDisabled,
                        ]}
                        onPress={() => handleSelectBoardMode(mode)}
                        disabled={disabled}
                      >
                        <Text
                          style={[
                            styles.modeSegmentText,
                            effectiveSelected && styles.modeSegmentTextActive,
                            disabled && styles.modeSegmentTextDisabled,
                          ]}
                        >
                          {BOARD_MODE_SHORT_LABELS[mode]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* Row 2: Captions (CC) Toggle Switch */}
              <View style={styles.optionsRow}>
                <Text style={styles.optionsRowLabel}>Captions (CC)</Text>
                <Switch
                  value={showCaptions}
                  onValueChange={setShowCaptions}
                  trackColor={{ false: "#E2E8F0", true: "#93C5FD" }}
                  thumbColor={showCaptions ? "#2563EB" : "#FFFFFF"}
                  ios_backgroundColor="#E2E8F0"
                />
              </View>

              {/* Thin Divider + Row 3: Clear Board Action */}
              <View style={styles.optionsDivider} />
              <Pressable
                style={styles.clearBoardRow}
                onPress={handleClearBoard}
                accessibilityLabel="Clear whiteboard"
              >
                <Text style={styles.clearBoardIcon}>⌫</Text>
                <Text style={styles.clearBoardText}>Clear Board</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

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
      {/* LAYER 2: Unified Bottom Stack (Captions, Slim Player, PDF Chip,   */}
      {/*          & Unified Bottom Chat Dock with + and Smart Glowing ↑)   */}
      {/* ================================================================= */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        pointerEvents="box-none"
        style={[styles.bottomStackOuter, { bottom: insets.bottom + 10 }]}
      >
        <View
          pointerEvents="box-none"
          style={[styles.bottomStackInner, { maxWidth: hudMaxWidth }]}
        >
          {/* 2A. Compact Arabic Captions Strip (Only when active & CC enabled) */}
          {result && currentStep && showCaptions && (
            <View style={styles.captionStripCard}>
              <ScrollView
                style={styles.captionScroll}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.captionSpeechAr}>
                  {formatBidiArabicCaption(currentStep.speech_ar)}
                </Text>

                {isLastStep && !!result.plan.quiz_question_ar && (
                  <View style={styles.captionQuizRow}>
                    <Text style={styles.captionQuizText}>
                      سؤال تطبيقي:{" "}
                      {formatBidiArabicCaption(result.plan.quiz_question_ar)}
                    </Text>
                  </View>
                )}
              </ScrollView>
            </View>
          )}

          {/* 2B. Slim Light Playback / Status Strip (Only while loading or lecture active) */}
          {isBusy ? (
            <View style={styles.slimStatusPill}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={styles.slimStatusText} numberOfLines={1}>
                {askLoading
                  ? "Answering & voicing follow-up..."
                  : hasAttachedPdf
                    ? `Analyzing & voicing page ${selectedPage}...`
                    : freeSearchEnabled
                      ? "Researching & voicing explanation..."
                      : "Thinking & voicing explanation..."}
              </Text>
            </View>
          ) : result && currentStep ? (
            <View style={styles.slimPlayerPill}>
              <Pressable
                style={[styles.playerJumpBtn, !canGoPrev && styles.dockDisabled]}
                onPress={() => canGoPrev && handleSelectStep(stepIndex - 1)}
                disabled={!canGoPrev}
                accessibilityLabel="Previous step"
              >
                <Text style={styles.playerJumpText}>‹</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.playerPlayBtn,
                  !currentStepAudioUri && styles.dockDisabled,
                ]}
                onPress={handleTogglePlayPause}
                disabled={!currentStepAudioUri}
                accessibilityLabel={
                  isPlaying || status.playing ? "Pause lecture" : "Play lecture"
                }
              >
                <Text style={styles.playerPlayText}>
                  {isPlaying || status.playing ? "⏸" : "▶"}
                </Text>
              </Pressable>

              <Pressable
                style={styles.playerReplayBtn}
                onPress={handleReplayStep}
                accessibilityLabel="Replay current step"
              >
                <Text style={styles.playerReplayText}>↺</Text>
              </Pressable>

              {/* Continuous Lecture Progress Bar */}
              <View style={styles.playerProgressWrap}>
                <View style={styles.playerProgressTrack}>
                  <View
                    style={[
                      styles.playerProgressFill,
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
                            styles.playerProgressTick,
                            isPassed && styles.playerProgressTickPassed,
                            { left: `${(ratio * 100).toFixed(2)}%` },
                          ]}
                        />
                      );
                    })}
                </View>
                <Text style={styles.playerMicroLabel} numberOfLines={1}>
                  {isTablet
                    ? `${Math.round(overallProgress * 100)}% • ${stepIndex + 1}/${steps.length}`
                    : `${stepIndex + 1}/${steps.length}`}
                </Text>
              </View>

              <Pressable
                style={[styles.playerJumpBtn, !canGoNext && styles.dockDisabled]}
                onPress={() => canGoNext && handleSelectStep(stepIndex + 1)}
                disabled={!canGoNext}
                accessibilityLabel="Next step"
              >
                <Text style={styles.playerJumpText}>›</Text>
              </Pressable>

              <Pressable
                style={styles.playerSpeedBtn}
                onPress={handleCycleSpeed}
              >
                <Text style={styles.playerSpeedText}>
                  {playbackSpeed.toFixed(playbackSpeed === 1.25 ? 2 : 1)}x
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* 2C. Dynamic Real PDF Filename Chip & Real Page Counter Pill (Only when PDF/lecture loaded) */}
          {hasAttachedPdf && (
            <View style={styles.pdfAttachmentRow}>
              <View style={styles.pdfFileChip}>
                <View style={styles.pdfBadgeIcon}>
                  <Text style={styles.pdfBadgeIconText}>PDF</Text>
                </View>
                <Text
                  style={styles.pdfFileNameText}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {attachedPdfName}
                </Text>
                <Pressable
                  style={styles.pdfDetachBtn}
                  onPress={handleDetachPdf}
                  disabled={isBusy}
                  hitSlop={6}
                  accessibilityLabel="Detach PDF and return to Free Q&A mode"
                >
                  <Text style={styles.pdfDetachBtnText}>×</Text>
                </Pressable>
              </View>

              <Pressable
                style={[
                  styles.pageCounterPill,
                  pageWheelOpen && styles.pageCounterPillActive,
                ]}
                onPress={() => {
                  Keyboard.dismiss();
                  setOptionsMenuOpen(false);
                  setPageWheelOpen((v) => !v);
                }}
                disabled={isBusy}
                accessibilityLabel="Open circular page wheel picker"
              >
                <Text style={styles.pageCounterText}>
                  P. {selectedPage} / {totalPages ?? effectiveTotalPages}
                </Text>
                <Text style={styles.pageCounterChevron}>
                  {pageWheelOpen ? "▴" : "▾"}
                </Text>
              </Pressable>
            </View>
          )}

          {/* 2D. Unified Bottom Chat Dock (🌐 + اسأل أي سؤال + Circular + + Smart Glowing ↑) */}
          <View style={styles.unifiedChatPill}>
            <Pressable
              style={[
                styles.webToggleBtn,
                freeSearchEnabled && styles.webToggleBtnActive,
              ]}
              onPress={() => setFreeSearchEnabled((v) => !v)}
              disabled={isBusy}
              accessibilityLabel="Toggle web search sources"
            >
              <Text
                style={[
                  styles.webToggleIcon,
                  freeSearchEnabled && styles.webToggleIconActive,
                ]}
              >
                🌐
              </Text>
            </Pressable>

            <TextInput
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="اسأل أي سؤال"
              placeholderTextColor="#94A3B8"
              style={styles.unifiedChatInput}
              returnKeyType="send"
              editable={!isBusy}
              onSubmitEditing={() => void handleUnifiedSend()}
            />

            {/* Side-by-side circular + (PDF Upload) & Smart Glowing ↑ (Send) */}
            <View style={styles.dockRightActions}>
              <Pressable
                style={[styles.dockPlusBtn, isBusy && styles.dockDisabled]}
                onPress={() => void handlePickPdf()}
                disabled={isBusy}
                accessibilityLabel="Attach lecture PDF"
              >
                <Text style={styles.dockPlusBtnText}>+</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.dockSendBtn,
                  canSend ? styles.dockSendBtnActive : styles.dockSendBtnDimmed,
                ]}
                onPress={() => void handleUnifiedSend()}
                disabled={!canSend}
                accessibilityLabel={
                  hasAttachedPdf && !chatInput.trim()
                    ? `Explain page ${selectedPage}`
                    : "Send question"
                }
              >
                {isBusy ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.dockSendBtnText}>↑</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* ================================================================= */}
      {/* LAYER 3: Floating 3D Cylindrical Circular Gear Page Wheel Picker  */}
      {/* ================================================================= */}
      <CircularWheelPagePicker
        visible={pageWheelOpen && hasAttachedPdf}
        totalPages={effectiveTotalPages}
        selectedPage={selectedPage}
        bottomOffset={insets.bottom + 114}
        onChangePage={(page) => setSelectedPage(page)}
        onClose={() => setPageWheelOpen(false)}
      />

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
  emptyCleanPaper: {
    flex: 1,
    backgroundColor: "#FAF8F5",
  },

  // Stage 16 Decluttered 2-Pill Top Header
  topHudOuter: {
    position: "absolute",
    left: 14,
    right: 14,
    zIndex: 30,
    alignItems: "center",
  },
  topHudRow: {
    width: "100%",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerPillBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    borderWidth: 1,
    borderColor: "#E7E2D9",
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  headerPillBtnActive: {
    borderColor: "#BFDBFE",
    backgroundColor: "#EFF6FF",
  },
  headerPillIcon: {
    fontSize: 13,
    color: "#334155",
    includeFontPadding: false,
  },
  headerPillText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0F172A",
    includeFontPadding: false,
  },
  headerPillChevron: {
    fontSize: 11,
    color: "#64748B",
    marginLeft: -2,
    includeFontPadding: false,
  },

  // Floating Options Popover Card
  popoverOverlayRoot: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 42,
  },
  optionsAnchorWrap: {
    position: "absolute",
    right: 14,
    alignItems: "flex-end",
  },
  optionsPopoverCard: {
    width: 264,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
    shadowColor: "#0F172A",
    shadowOpacity: 0.14,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  optionsLabelCol: {
    flex: 1,
    gap: 2,
  },
  optionsRowLabel: {
    fontSize: 13.5,
    fontWeight: "700",
    color: "#0F172A",
    includeFontPadding: false,
  },
  optionsSubHint: {
    fontSize: 10,
    fontWeight: "600",
    color: "#64748B",
    includeFontPadding: false,
  },
  modeSegmentWrap: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  modeSegmentBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 7,
  },
  modeSegmentBtnActive: {
    backgroundColor: "#2563EB",
  },
  modeSegmentBtnDisabled: {
    opacity: 0.35,
  },
  modeSegmentText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#475569",
    includeFontPadding: false,
  },
  modeSegmentTextActive: {
    color: "#FFFFFF",
  },
  modeSegmentTextDisabled: {
    color: "#94A3B8",
  },
  optionsDivider: {
    height: 1,
    backgroundColor: "#E2E8F0",
  },
  clearBoardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 2,
  },
  clearBoardIcon: {
    fontSize: 15,
    color: "#DC2626",
    includeFontPadding: false,
  },
  clearBoardText: {
    fontSize: 13.5,
    fontWeight: "700",
    color: "#DC2626",
    includeFontPadding: false,
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

  // Stage 16 Unified Bottom Stack
  bottomStackOuter: {
    position: "absolute",
    left: 14,
    right: 14,
    zIndex: 30,
    alignItems: "center",
  },
  bottomStackInner: {
    width: "100%",
    alignSelf: "center",
    gap: 8,
  },
  captionStripCard: {
    width: "100%",
    backgroundColor: "rgba(255, 255, 255, 0.96)",
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

  // Slim Light Playback & Status Pills (Replaces Dark Bottom Bar)
  slimStatusPill: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    borderWidth: 1,
    borderColor: "#DBEAFE",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: "#0F172A",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  slimStatusText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: "#1E293B",
    includeFontPadding: false,
  },
  slimPlayerPill: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderWidth: 1,
    borderColor: "#E7E2D9",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 6,
    shadowColor: "#0F172A",
    shadowOpacity: 0.07,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  playerJumpBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1F5F9",
  },
  playerJumpText: {
    color: "#334155",
    fontSize: 16,
    fontWeight: "700",
    marginTop: -1,
    includeFontPadding: false,
  },
  playerPlayBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#2563EB",
    alignItems: "center",
    justifyContent: "center",
  },
  playerPlayText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
    includeFontPadding: false,
  },
  playerReplayBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1F5F9",
  },
  playerReplayText: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "700",
    includeFontPadding: false,
  },
  playerProgressWrap: {
    flex: 1,
    minWidth: 56,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
    gap: 2,
  },
  playerProgressTrack: {
    width: "100%",
    height: 5,
    borderRadius: 999,
    backgroundColor: "#E2E8F0",
    overflow: "hidden",
    justifyContent: "center",
    position: "relative",
  },
  playerProgressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: "#2563EB",
  },
  playerProgressTick: {
    position: "absolute",
    top: 1.25,
    width: 2.5,
    height: 2.5,
    borderRadius: 1.25,
    marginLeft: -1.25,
    backgroundColor: "rgba(100, 116, 139, 0.35)",
  },
  playerProgressTickPassed: {
    backgroundColor: "rgba(255, 255, 255, 0.85)",
  },
  playerMicroLabel: {
    color: "#64748B",
    fontSize: 9.5,
    fontWeight: "700",
    includeFontPadding: false,
  },
  playerSpeedBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#EFF6FF",
  },
  playerSpeedText: {
    color: "#1D4ED8",
    fontSize: 11,
    fontWeight: "800",
    includeFontPadding: false,
  },

  // Dynamic Real PDF Filename Chip & Page Counter Pill
  pdfAttachmentRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  pdfFileChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 999,
    paddingLeft: 8,
    paddingRight: 8,
    paddingVertical: 6,
    shadowColor: "#0F172A",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  pdfBadgeIcon: {
    backgroundColor: "#FEE2E2",
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  pdfBadgeIconText: {
    fontSize: 9,
    fontWeight: "900",
    color: "#DC2626",
    letterSpacing: 0.4,
    includeFontPadding: false,
  },
  pdfFileNameText: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: "700",
    color: "#0F172A",
    includeFontPadding: false,
  },
  pdfDetachBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  pdfDetachBtnText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#64748B",
    marginTop: -1,
    includeFontPadding: false,
  },
  pageCounterPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    shadowColor: "#0F172A",
    shadowOpacity: 0.07,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  pageCounterPillActive: {
    backgroundColor: "#EFF6FF",
    borderColor: "#2563EB",
  },
  pageCounterText: {
    fontSize: 12.5,
    fontWeight: "800",
    color: "#1D4ED8",
    includeFontPadding: false,
  },
  pageCounterChevron: {
    fontSize: 10.5,
    color: "#2563EB",
    includeFontPadding: false,
  },

  // Unified Bottom Chat Dock
  unifiedChatPill: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 999,
    paddingLeft: 8,
    paddingRight: 7,
    paddingVertical: 6,
    gap: 7,
    shadowColor: "#0F172A",
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
  unifiedChatInput: {
    flex: 1,
    fontSize: 14.5,
    color: "#0F172A",
    paddingVertical: 6,
    paddingHorizontal: 4,
    textAlign: "right",
    includeFontPadding: false,
  },
  webToggleBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  webToggleBtnActive: {
    backgroundColor: "#CCFBF1",
    borderWidth: 1,
    borderColor: "#5EEAD4",
  },
  webToggleIcon: {
    fontSize: 15,
    opacity: 0.45,
    includeFontPadding: false,
  },
  webToggleIconActive: {
    opacity: 1,
  },
  dockRightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dockPlusBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#F1F5F9",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    alignItems: "center",
    justifyContent: "center",
  },
  dockPlusBtnText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#334155",
    marginTop: -1,
    includeFontPadding: false,
  },
  dockSendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  dockSendBtnActive: {
    backgroundColor: "#2563EB",
    shadowColor: "#2563EB",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  dockSendBtnDimmed: {
    backgroundColor: "#CBD5E1",
  },
  dockSendBtnText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
    includeFontPadding: false,
  },
  dockDisabled: {
    opacity: 0.38,
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
