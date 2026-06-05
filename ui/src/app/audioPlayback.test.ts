import { describe, expect, it, vi } from "vitest";
import { stopAppAudio, type SpeechResult } from "./audioPlayback";

function ref<T>(current: T) {
  return { current };
}

describe("stopAppAudio", () => {
  it("stops browser speech, server audio, and queued response readback together", () => {
    const originalQueue = Promise.resolve("queued");
    const speechFinish = vi.fn((result: SpeechResult) => {
      expect(result).toBe("stopped");
    });
    const audioFinish = vi.fn((result: SpeechResult) => {
      expect(result).toBe("stopped");
    });
    const source = {
      stop: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AudioBufferSourceNode;
    const player = {
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLAudioElement;
    const speechSynthesis = {
      cancel: vi.fn(),
    } as Pick<SpeechSynthesis, "cancel">;
    const revokeObjectUrl = vi.fn();
    const handles = {
      audioStopToken: ref(4),
      responseAudioQueue: ref<Promise<unknown>>(originalQueue),
      activeSpeechFinish: ref<((result: SpeechResult) => void) | null>(speechFinish),
      activeUtterance: ref({} as SpeechSynthesisUtterance),
      activeAudioSource: ref<AudioBufferSourceNode | null>(source),
      activeAudioElement: ref<HTMLAudioElement | null>(player),
      activeAudioFinish: ref<((result: SpeechResult) => void) | null>(audioFinish),
      activeAudioUrl: ref("blob:test-audio"),
      speechSynthesis,
      revokeObjectUrl,
    };

    stopAppAudio(handles);

    expect(handles.audioStopToken.current).toBe(5);
    expect(handles.responseAudioQueue.current).not.toBe(originalQueue);
    expect(speechFinish).toHaveBeenCalledOnce();
    expect(speechSynthesis.cancel).toHaveBeenCalledOnce();
    expect(source.stop).toHaveBeenCalledWith(0);
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.removeAttribute).toHaveBeenCalledWith("src");
    expect(player.load).toHaveBeenCalledOnce();
    expect(audioFinish).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:test-audio");
    expect(handles.activeSpeechFinish.current).toBeNull();
    expect(handles.activeUtterance.current).toBeNull();
    expect(handles.activeAudioSource.current).toBeNull();
    expect(handles.activeAudioElement.current).toBeNull();
    expect(handles.activeAudioFinish.current).toBeNull();
    expect(handles.activeAudioUrl.current).toBeNull();
  });
});
