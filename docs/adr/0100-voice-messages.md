# 0100. Voice messages

- Status: Accepted
- Date: 2026-10-31
- Code: `packages/adapters/src/speech.ts`, `packages/engine/src/speech-settings.ts`, `packages/engine/src/voice.ts`, `packages/db/src/schema/voice.ts`, `apps/server/src/routes/app/voice.ts`

## Context

People want to talk to agents, on the web, the desktop and the phone. Models take text, not audio. To the person it should feel like sending audio; turning it into text is an internal step.

## Decision

### 1. The message is the audio; the agent reads its words

We keep the recording and the apps show a wave and a player. The words go in `messages.body`, so routing, mentions, context, memory and search work as for any message, and `meta.voice` (`clipId`, `durationMs`, `peaks`, `expiresAt`, `noWords`) says it is a voice message.

### 2. Words only in the message itself: one line under the wave, the rest on request

On the message itself, one line of the words sits under the wave, in the player's card, and opens in full there; they come from `message.body`, so they stay in the API. Everywhere a message is listed, they don't appear: channel and DM previews, thread titles and excerpts, notifications, push, quotes and search snippets go through `readableBody` and say "voice message" in the reader's language (`mediaKind: "voice"`). A voice message is found by its words and shown as its audio. When no engine could make out the words, `body` holds a placeholder for the agent and `meta.voice.noWords` is true, so the apps never offer it as text.

### 3. One interface, swappable engines

`SpeechEngine` is a small adapter per provider: AssemblyAI, ElevenLabs, Soniox, and the OpenAI format for OpenAI, Groq and a server of one's own. Engines are tried in order (`SPEECH_ENGINES`), the next one taking over when one fails. The workspace's names (agents, people, channels) go with every call, so nobody keeps a vocabulary list. With no engine, the microphone stays hidden and the server still needs only Postgres.

The key is the server's, not the workspace's. On agentes.chat's servers it comes from the environment and nobody chooses. Elsewhere the installation's owner may also pick a provider and paste its key in Settings, kept like the Jev key (ADR 0073): sealed, tried with a second of silence before it is stored, never returned.

### 4. The finished recording first

The app sends the finished recording and shows it at once. The server stores it, answers, and a job (`voice.transcribe`) gets the words and posts the message through `postPersonMessage`, so what was said survives a closed app or a provider's bad minute, and a resend with the same `clientId` writes nothing new. It is also the only path that needs no new native module on the phone. Nothing said drops the recording and tells its sender (`voice.dropped`). After every try fails, the message still goes, as audio people can hear.

Streaming audio while the person speaks would make the words ready on release. It is left for later, as another method on `SpeechEngine` next to `file`.

### 5. Recordings as they came

The server stores the app's recording as is, with no transcoding, so it needs no encoder in the image. Only audio types are accepted, since they are served back from our own address.

### 6. Outside the Drive

A recording is part of its message, so it lives in `voice_clips` on the workspace's storage (`BlobStoreResolver`), not in `artifacts`. Who can read the channel can play it. It counts in `storedBytes` and moves in a storage migration.

### 7. Fair use, invisible

On agentes.chat's servers only: a person and a workspace have a number of minutes in a rolling 24 hours (`VOICE_LIMIT_*`, 60 per person; 20 per member, at least 300, per workspace; 0 turns one off). It is checked before a recording starts and when it arrives, never cutting one short. Nobody sees a counter or a price. It is counted from `voice_clips`, not `usage_records`, so nothing reaches the Usage screens. A self-hosted server has no limit.

### 8. Recordings expire

`VOICE_RETENTION_DAYS` (default 90; 0 keeps them forever) applies on every server, so storage doesn't fill up. A daily sweep deletes the audio in pages and sets `voice_clips.audio_deleted_at`. The row stays, as fair use counts it, and so does the message with its words. A recording waiting for its words never expires. The audio route answers 410 `voice.expired` for a swept recording or one past its date; swept recordings leave `storedBytes` and aren't copied by a storage migration. `meta.voice.expiresAt` is written when the message is posted, so a later change of the setting applies on the server but doesn't rewrite that date.

## Consequences

- Recordings hold people's voices and go to the chosen provider; `SELF_HOSTING.md` says so, and a server of one's own keeps them in.
- Agents aren't told yet that a message was spoken: a change to their prompt needs an eval first.
