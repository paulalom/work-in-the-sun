export type SpeechResult = true | false | "stopped";

interface RefLike<T> {
  current: T;
}

export interface AppAudioPlaybackHandles {
  audioStopToken: RefLike<number>;
  responseAudioQueue: RefLike<Promise<unknown>>;
  activeSpeechFinish: RefLike<((result: SpeechResult) => void) | null>;
  activeUtterance: RefLike<SpeechSynthesisUtterance | null>;
  activeAudioSource: RefLike<AudioBufferSourceNode | null>;
  activeAudioElement: RefLike<HTMLAudioElement | null>;
  activeAudioFinish: RefLike<((result: SpeechResult) => void) | null>;
  activeAudioUrl: RefLike<string | null>;
  speechSynthesis?: Pick<SpeechSynthesis, "cancel"> | null;
  revokeObjectUrl?: (url: string) => void;
}

function ignorePlaybackStopError(action: () => void) {
  try {
    action();
  } catch {
    // The browser may have already ended or detached the audio node.
  }
}

function finishPlayback(ref: RefLike<((result: SpeechResult) => void) | null>) {
  const finish = ref.current;

  if (!finish) {
    return;
  }

  try {
    ignorePlaybackStopError(() => finish("stopped"));
  } finally {
    if (ref.current === finish) {
      ref.current = null;
    }
  }
}

export function stopAppAudio(handles: AppAudioPlaybackHandles) {
  handles.audioStopToken.current += 1;
  handles.responseAudioQueue.current = Promise.resolve();

  finishPlayback(handles.activeSpeechFinish);
  ignorePlaybackStopError(() => handles.speechSynthesis?.cancel());
  handles.activeUtterance.current = null;

  const source = handles.activeAudioSource.current;

  if (source) {
    ignorePlaybackStopError(() => source.stop(0));
    ignorePlaybackStopError(() => source.disconnect());
    handles.activeAudioSource.current = null;
  }

  const player = handles.activeAudioElement.current;

  if (player) {
    ignorePlaybackStopError(() => player.pause());
    ignorePlaybackStopError(() => player.removeAttribute("src"));
    ignorePlaybackStopError(() => player.load());
    handles.activeAudioElement.current = null;
  }

  finishPlayback(handles.activeAudioFinish);

  const url = handles.activeAudioUrl.current;

  if (url) {
    ignorePlaybackStopError(() => handles.revokeObjectUrl?.(url));

    if (handles.activeAudioUrl.current === url) {
      handles.activeAudioUrl.current = null;
    }
  }
}
