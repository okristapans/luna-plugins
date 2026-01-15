import { LunaUnload, unloadSet } from "@luna/core";
import { ipcRenderer, MediaItem, PlayState, redux } from "@luna/lib";
import { send, session } from "./remoteService.native";

export * from "./remoteService.native";

export const unloads = new Set<LunaUnload>();

let hasActiveSession = false;
let lastKnownMediaId: string | null = null;

// =====================
// FROM REMOTE
// =====================

/**
 * Media change from remote
 * Spotify Connect behavior:
 * - Load media
 * - DO NOT autoplay
 */
ipcRenderer.on(
	unloads,
	"remote.desktop.notify.media.changed",
	async ({ mediaId }) => {
		if (!mediaId) return;

		// Avoid reloading same track on reconnect
		if (mediaId === lastKnownMediaId) return;

		lastKnownMediaId = mediaId;

		const mediaItem = await MediaItem.fromId(mediaId);
		if (!mediaItem) return;

		// Load only – never play on restore
		if (typeof (mediaItem as any).load === "function") {
			(mediaItem as any).load();
		}
	}
);

/**
 * Prefetch only
 */
ipcRenderer.on(
	unloads,
	"remote.desktop.prefetch",
	({ mediaId, mediaType }) => {
		redux.actions["player/PRELOAD_ITEM"]({
			productId: mediaId,
			productType: mediaType === 0 ? "track" : "video",
		});
	}
);

/**
 * Explicit transport commands
 */
ipcRenderer.on(unloads, "remote.desktop.seek", (time: number) =>
	PlayState.seek(time / 1000)
);

ipcRenderer.on(unloads, "remote.desktop.play", () => {
	session.endRestore();
	PlayState.play();
});

ipcRenderer.on(unloads, "remote.desktop.pause", PlayState.pause.bind(PlayState));

ipcRenderer.on(
	unloads,
	"remote.desktop.set.shuffle",
	PlayState.setShuffle.bind(PlayState)
);

ipcRenderer.on(
	unloads,
	"remote.desktop.set.repeat.mode",
	PlayState.setRepeatMode.bind(PlayState)
);

ipcRenderer.on(
	unloads,
	"remote.destop.set.volume.mute",
	({ level, mute }: { level: number; mute: boolean }) => {
		redux.actions["playbackControls/SET_MUTE"](mute);
		redux.actions["playbackControls/SET_VOLUME"]({
			volume: Math.min(level * 100, 100),
		});
	}
);

// =====================
// TO REMOTE
// =====================

const sessionUnloads = new Set<LunaUnload>();

/**
 * Session lifecycle
 */
ipcRenderer.on(
	unloads,
	"remote.desktop.notify.session.state",
	(state) => {
		// 0 = disconnected
		if (state === 0) {
			hasActiveSession = false;
			session.beginRestore();

			// Spotify pauses on disconnect
			PlayState.pause();

			unloadSet(sessionUnloads);
			return;
		}

		// Connected or restored
		if (!hasActiveSession) {
			hasActiveSession = true;
			session.beginRestore();
		}

		if (sessionUnloads.size !== 0) return;

		/**
		 * Progress updates
		 * Only while actively playing
		 */
		ipcRenderer.on(
			sessionUnloads,
			"client.playback.playersignal",
			({ time }: { time: number }) => {
				if (PlayState.state !== "PLAYING") return;

				send({
					command: "onProgressUpdated",
					duration: 0,
					progress: time * 1000,
					type: "media",
				});
			}
		);

		/**
		 * Playback state sync
		 */
		redux.intercept(
			"playbackControls/SET_PLAYBACK_STATE",
			sessionUnloads,
			(state) => {
				switch (state) {
					case "IDLE":
						return send({
							command: "onStatusUpdated",
							playerState: "idle",
							type: "media",
						});

					case "NOT_PLAYING":
						return send({
							command: "onStatusUpdated",
							playerState: "paused",
							type: "media",
						});

					case "PLAYING":
						session.endRestore();
						return send({
							command: "onStatusUpdated",
							playerState: "playing",
							type: "media",
						});

					case "STALLED":
						return send({
							command: "onStatusUpdated",
							playerState: "buffering",
							type: "media",
						});
				}
			}
		);

		/**
		 * Track completion
		 * Request next media ONLY after completion
		 */
		redux.intercept(
			"playbackControls/ENDED",
			sessionUnloads,
			({ reason }) => {
				if (reason === "completed") {
					send({
						command: "onPlaybackCompleted",
						hasNextMedia: true,
						type: "media",
					});
					send({
						command: "onRequestNextMedia",
						type: "media",
					});
				}
				return true;
			}
		);

		/**
		 * Manual skip
		 */
		redux.intercept(
			"playbackControls/SKIP_NEXT",
			sessionUnloads,
			() => {
				PlayState.pause();
				send({
					command: "onStatusUpdated",
					playerState: "idle",
					type: "media",
				});
				send({
					command: "onPlaybackCompleted",
					hasNextMedia: false,
					type: "media",
				});
				return true;
			}
		);
	}
);

unloads.add(() => unloadSet(sessionUnloads));
