<script setup lang="ts">
// The camera beside a barcode or IMEI field (`ADR-043`).
//
// One component for every such field in the app, so the behaviour cannot drift: the
// same formats, the same 15-digits rule, the same honest line when the machine cannot
// read a code. It is a *button*, not a screen — it opens the camera for one reading
// and closes, which is what a shopkeeper needs while typing at a counter.
//
// Nothing leaves the device: the video frame is drawn onto a canvas and decoded here.

import { nextTick, onUnmounted, ref } from 'vue';

import Icon from './Icon.vue';
import { toast } from './toast';
import {
  cameraFailureNote,
  classifyScan,
  createFrameDecoder,
  scannerSupport,
  type FrameDecoder,
  type ScanReading,
} from './scan';

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

const support = scannerSupport();
const scanning = ref(false);
const note = ref<string | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);
let mediaStream: MediaStream | null = null;
let scanTimer: ReturnType<typeof setInterval> | undefined;
let decoder: FrameDecoder | null = null;

function stop(): void {
  if (scanTimer !== undefined) {
    clearInterval(scanTimer);
    scanTimer = undefined;
  }
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  decoder = null;
  scanning.value = false;
}

async function start(): Promise<void> {
  if (!support.supported) {
    note.value = support.note;
    toast(support.note, 'info');
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (error) {
    note.value = cameraFailureNote(error);
    toast(note.value, 'err');
    return;
  }
  note.value = null;
  scanning.value = true;
  // The <video> is behind `v-if="scanning || note !== null"`, so it exists only
  // after Vue has painted the open panel — asking for it a frame too early reads
  // `null` and the preview stays black while the timer keeps decoding nothing.
  await nextTick();
  const video = videoEl.value;
  if (video !== null) {
    video.srcObject = mediaStream;
    await video.play().catch(() => undefined);
  }

  // The decoder is chosen after the camera opened, so a device that cannot decode
  // says so without first asking for a permission it will never use.
  try {
    decoder = await createFrameDecoder();
  } catch {
    stop();
    note.value =
      'مش قادر أجهّز قارئ الباركود على الجهاز ده — اكتب الرقم أو الصقه، والطريقة دي شغالة زي ما هي.';
    toast(note.value, 'err');
    return;
  }

  const grab = document.createElement('canvas');
  scanTimer = setInterval(() => {
    const source = videoEl.value;
    const active = decoder;
    if (source === null || active === null || source.videoWidth === 0) return;
    // The bundled reader is pure JavaScript: a full 4K frame on a shop tablet is
    // wasted work. 640px is enough for a retail code and keeps the phone cool.
    const width = active.kind === 'zxing' ? Math.min(source.videoWidth, 640) : source.videoWidth;
    const height = Math.round((source.videoHeight / source.videoWidth) * width);
    grab.width = width;
    grab.height = height;
    const ctx = grab.getContext('2d');
    if (ctx === null) return;
    ctx.drawImage(source, 0, 0, width, height);
    void active.decode(grab).then((text) => {
      if (text === null) return;
      stop();
      emit('scan', classifyScan(text));
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
