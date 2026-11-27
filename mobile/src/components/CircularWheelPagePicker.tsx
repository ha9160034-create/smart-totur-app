import React, { useCallback, useMemo, useRef } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

export const WHEEL_ITEM_HEIGHT = 40;
const VISIBLE_ITEMS = 5;
const WHEEL_HEIGHT = WHEEL_ITEM_HEIGHT * VISIBLE_ITEMS;
const WHEEL_VERTICAL_PAD = WHEEL_ITEM_HEIGHT * 2;

function triggerWheelTickHaptic(): void {
  try {
    void Haptics.selectionAsync().catch(() => {
      if (Platform.OS === "android") {
        Vibration.vibrate(6);
      }
    });
  } catch {
    if (Platform.OS === "android") {
      try {
        Vibration.vibrate(6);
      } catch {
        // Ignore if haptics/vibration unavailable
      }
    }
  }
}

interface WheelRowProps {
  pageNumber: number;
  index: number;
  scrollY: SharedValue<number>;
  onSelectIndex: (index: number, pageNumber: number) => void;
}

const WheelRow: React.FC<WheelRowProps> = React.memo(
  ({ pageNumber, index, scrollY, onSelectIndex }) => {
    const animStyle = useAnimatedStyle(() => {
      const distance = Math.abs(scrollY.value / WHEEL_ITEM_HEIGHT - index);
      const scale = interpolate(
        distance,
        [0, 1, 2, 3],
        [1.0, 0.88, 0.78, 0.72],
        Extrapolation.CLAMP
      );
      const opacity = interpolate(
        distance,
        [0, 1, 2, 3],
        [1.0, 0.56, 0.28, 0.14],
        Extrapolation.CLAMP
      );
      return {
        opacity,
        transform: [{ scale }],
      };
    });

    const textColorStyle = useAnimatedStyle(() => {
      const distance = Math.abs(scrollY.value / WHEEL_ITEM_HEIGHT - index);
      const isCenter = distance < 0.45;
      return {
        color: isCenter ? "#1D4ED8" : "#334155",
      };
    });

    return (
      <Pressable
        style={styles.wheelRow}
        onPress={() => onSelectIndex(index, pageNumber)}
        accessibilityRole="button"
        accessibilityLabel={`Select page ${pageNumber}`}
      >
        <Animated.View style={[styles.wheelRowInner, animStyle]}>
          <Animated.Text style={[styles.wheelRowText, textColorStyle]}>
            {pageNumber}
          </Animated.Text>
        </Animated.View>
      </Pressable>
    );
  }
);

interface WheelCoreProps {
  totalPages: number;
  selectedPage: number;
  onChangePage: (page: number) => void;
  onClose: () => void;
}

const WheelCore: React.FC<WheelCoreProps> = ({
  totalPages,
  selectedPage,
  onChangePage,
  onClose,
}) => {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const clampedInitialPage = Math.max(1, Math.min(safeTotal, selectedPage));
  const isCircular = safeTotal >= 5;

  const data = useMemo<number[]>(() => {
    const singleCycle = Array.from({ length: safeTotal }, (_, i) => i + 1);
    if (!isCircular) return singleCycle;
    // 3-cycle ring centered on the middle cycle for seamless circular gear wrap-around
    return [...singleCycle, ...singleCycle, ...singleCycle];
  }, [safeTotal, isCircular]);

  const initialIndex = isCircular
    ? safeTotal + (clampedInitialPage - 1)
    : clampedInitialPage - 1;

  const flatListRef = useRef<Animated.FlatList<number>>(null);
  const scrollY = useSharedValue(initialIndex * WHEEL_ITEM_HEIGHT);
  const lastNotchIndex = useSharedValue(initialIndex);

  const recenterAndCommit = useCallback(
    (offsetY: number) => {
      const maxIdx = Math.max(0, data.length - 1);
      const rawIndex = Math.max(
        0,
        Math.min(maxIdx, Math.round(offsetY / WHEEL_ITEM_HEIGHT))
      );
      const page = ((rawIndex % safeTotal) + safeTotal) % safeTotal + 1;
      onChangePage(page);

      if (isCircular && (rawIndex < safeTotal || rawIndex >= safeTotal * 2)) {
        const middleIndex = safeTotal + (page - 1);
        const middleOffset = middleIndex * WHEEL_ITEM_HEIGHT;
        lastNotchIndex.value = middleIndex;
        scrollY.value = middleOffset;
        flatListRef.current?.scrollToOffset({
          offset: middleOffset,
          animated: false,
        });
      }
    },
    [data.length, safeTotal, isCircular, onChangePage, lastNotchIndex, scrollY]
  );

  const handleScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      const y = event.contentOffset.y;
      scrollY.value = y;
      const notch = Math.round(y / WHEEL_ITEM_HEIGHT);
      if (notch !== lastNotchIndex.value) {
        lastNotchIndex.value = notch;
        runOnJS(triggerWheelTickHaptic)();
      }
    },
  });

  const handleMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      recenterAndCommit(e.nativeEvent.contentOffset.y);
    },
    [recenterAndCommit]
  );

  const handleScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const vy = Math.abs(e.nativeEvent.velocity?.y ?? 0);
      if (vy < 0.08) {
        recenterAndCommit(e.nativeEvent.contentOffset.y);
      }
    },
    [recenterAndCommit]
  );

  const handlePressIndex = useCallback(
    (index: number, pageNumber: number) => {
      triggerWheelTickHaptic();
      onChangePage(pageNumber);
      flatListRef.current?.scrollToOffset({
        offset: index * WHEEL_ITEM_HEIGHT,
        animated: true,
      });
    },
    [onChangePage]
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<number> | null | undefined, index: number) => ({
      length: WHEEL_ITEM_HEIGHT,
      offset: WHEEL_ITEM_HEIGHT * index,
      index,
    }),
    []
  );

  const renderItem = useCallback(
    ({ item, index }: { item: number; index: number }) => (
      <WheelRow
        pageNumber={item}
        index={index}
        scrollY={scrollY}
        onSelectIndex={handlePressIndex}
      />
    ),
    [scrollY, handlePressIndex]
  );

  const keyExtractor = useCallback(
    (_: number, index: number) => `wheel-p-${index}`,
    []
  );

  return (
    <View style={styles.popoverCard}>
      <View style={styles.popoverHeader}>
        <Text style={styles.popoverTitle}>
          Page {selectedPage} / {safeTotal}
        </Text>
        <Pressable
          style={styles.doneBtn}
          onPress={onClose}
          accessibilityLabel="Done selecting page"
        >
          <Text style={styles.doneBtnText}>Done</Text>
        </Pressable>
      </View>

      <View style={styles.wheelViewport}>
        {/* Subtle center selection highlight band */}
        <View pointerEvents="none" style={styles.centerHighlightBand} />

        <Animated.FlatList
          ref={flatListRef}
          data={data}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          initialScrollIndex={initialIndex}
          showsVerticalScrollIndicator={false}
          snapToInterval={WHEEL_ITEM_HEIGHT}
          decelerationRate="fast"
          bounces={!isCircular}
          contentContainerStyle={styles.wheelListContent}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          onScrollEndDrag={handleScrollEndDrag}
          windowSize={7}
          maxToRenderPerBatch={15}
          initialNumToRender={11}
        />
      </View>
    </View>
  );
};

export interface CircularWheelPagePickerProps {
  visible: boolean;
  totalPages: number;
  selectedPage: number;
  bottomOffset: number;
  onChangePage: (page: number) => void;
  onClose: () => void;
}

export const CircularWheelPagePicker: React.FC<CircularWheelPagePickerProps> = ({
  visible,
  totalPages,
  selectedPage,
  bottomOffset,
  onChangePage,
  onClose,
}) => {
  if (!visible) return null;

  return (
    <View style={styles.overlayRoot} pointerEvents="box-none">
      {/* Transparent tap-outside backdrop closes the gear wheel immediately */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close page wheel"
      />
      <View
        pointerEvents="box-none"
        style={[styles.anchorWrap, { bottom: bottomOffset }]}
      >
        <WheelCore
          key={`wheel-ring-${totalPages}`}
          totalPages={totalPages}
          selectedPage={selectedPage}
          onChangePage={onChangePage}
          onClose={onClose}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlayRoot: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 45,
  },
  anchorWrap: {
    position: "absolute",
    right: 16,
    alignItems: "flex-end",
  },
  popoverCard: {
    width: 176,
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    overflow: "hidden",
    shadowColor: "#0F172A",
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  popoverHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
    backgroundColor: "#F8FAFC",
  },
  popoverTitle: {
    fontSize: 11.5,
    fontWeight: "700",
    color: "#475569",
    includeFontPadding: false,
  },
  doneBtn: {
    backgroundColor: "#EFF6FF",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  doneBtnText: {
    fontSize: 11.5,
    fontWeight: "800",
    color: "#2563EB",
    includeFontPadding: false,
  },
  wheelViewport: {
    height: WHEEL_HEIGHT,
    width: "100%",
    position: "relative",
    overflow: "hidden",
  },
  centerHighlightBand: {
    position: "absolute",
    left: 10,
    right: 10,
    top: WHEEL_VERTICAL_PAD,
    height: WHEEL_ITEM_HEIGHT,
    borderRadius: 10,
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "rgba(37, 99, 235, 0.22)",
  },
  wheelListContent: {
    paddingVertical: WHEEL_VERTICAL_PAD,
  },
  wheelRow: {
    height: WHEEL_ITEM_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  wheelRowInner: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  wheelRowText: {
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 0.3,
    includeFontPadding: false,
  },
});

export default CircularWheelPagePicker;
