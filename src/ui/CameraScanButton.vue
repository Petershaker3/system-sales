<script setup lang="ts">
// The camera beside a barcode or IMEI field (`ADR-043`).
//
// One component for every such field in the app, so the behaviour cannot drift: the
// same formats, the same 15-digits rule, the same honest line when the machine cannot
// read a code. It is a *button*, not a screen — it opens the camera for one reading
// and closes, which is what a shopkeeper needs while typing at a counter.
//
// Nothing leaves the device: the video frame is drawn onto a canvas and decoded here.

import { onUnmounted, ref } from 'vue';

import Icon from './Icon.vue';
import { toast } from './toast';
import { classifyScan, SCAN_FORMATS, scannerSupport, type ScanReading } from './scan';

const props = withDefaults(
  defineProps<{
    /** Small text beside the icon; `false` gives an icon-only button. */
    readonly label?: string;
    /** The button inside a dense row (POS search) sits smaller. */
    readonly compact?: boolean;
    /** A hint under the camera, e.g. «الـ IMEI 15 رقم». */
    readonly hint?: string;
  }>(),
  { label: 'امسح', compact: false, hint: '' }
);

const emit = defineEmits<{
  /** One reading. The caller decides which field it belongs in. */
  scan: [reading: ScanReading];
}>();

type DetectorResult = { readonly rawValue?: string | undefined };
type Detector = {
  detect: (source: CanvasImageSource) => Promise<readonly DetectorResult[]>;
};
type DetectorCtor = new (options: { formats: readonly string[] }) => Detector;

const support = scannerSupport();
const scanning = ref(false);
const note = ref<string | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);
let mediaStream: MediaStream | null = null;
let scanTimer: ReturnType<typeof setInterval> | undefined;

function stop(): void {
  if (scanTimer !== undefined) {
    clearInterval(scanTimer);
    scanTimer = undefined;
  }
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  scanning.value = false;
}

async function start(): Promise<void> {
  if (!support.supported) {
    note.value = support.note;
    toast(support.note, 'info');
    return;
  }
  const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch {
    note.value =
      'الكاميرا اترفضت — اكتب الرقم بإيدك، أو اتأكد إن التطبيق مأذون له بالكاميرا.';
    toast(note.value, 'err');
    return;
  }
  note.value = null;
  scanning.value = true;
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  const video = videoEl.value;
  if (video !== null) {
    video.srcObject = mediaStream;
    await video.play().catch(() => undefined);
  }
  const detector = new Ctor({ formats: SCAN_FORMATS });
  const grab = document.createElement('canvas');
  scanTimer = setInterval(() => {
    const source = videoEl.value;
    if (source === null || source.videoWidth === 0) return;
    grab.width = source.videoWidth;
    grab.height = source.videoHeight;
    const ctx = grab.getContext('2d');
    if (ctx === null) return;
    ctx.drawImage(source, 0, 0);
    void detector.detect(grab).then((found) => {
      const first = found[0]?.rawValue?.trim();
      if (first === undefined || first === '') return;
      stop();
      emit('scan', classifyScan(first));
    });
  }, 420);
}

function toggle(): void {
  if (scanning.value) {
    stop();
    return;
  }
  void start();
}

onUnmounted(stop);
</script>

<template>
  <span class="camera-scan" :class="{ compact: props.compact }">
    <button
      type="button"
      class="btn"
      :class="[{ primary: !props.compact }, props.compact ? 'sm ghost' : '']"
      :title="props.label"
      data-camera-scan
      @click="toggle"
    >
      <Icon name="camera" />
      <span v-if="!props.compact">{{ scanning ? 'وقّف' : props.label }}</span>
    </button>

    <span v-if="scanning || note !== null" class="camera-scan-panel" data-camera-scan-panel>
      <video
        v-show="scanning"
        ref="videoEl"
        class="camera-scan-video"
        playsinline
        muted
      ></video>
      <span class="camera-scan-note">{{ note ?? props.hint }}</span>
    </span>
  </span>
</template>

<style scoped>
.camera-scan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.camera-scan.compact :deep(button) {
  padding: 4px 6px;
}

.camera-scan-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.camera-scan-video {
  width: 100%;
  max-height: 200px;
  border-radius: 10px;
  background: #141517;
}

.camera-scan-note {
  font-size: 0.8rem;
  color: var(--muted);
}
</style>
