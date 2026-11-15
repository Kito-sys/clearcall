# clearcall relay: joins every call, takes the guest's audio, removes background
# noise and other people's voices (Krisp BVC, runs in LiveKit Cloud), and publishes
# the cleaned voice as a track named "clean-voice" for the host to listen to.
import asyncio
import logging

from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, cli
from livekit.plugins import noise_cancellation

log = logging.getLogger("clearcall-relay")

SAMPLE_RATE = 48000
CHANNELS = 1

server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    room = ctx.room

    source = rtc.AudioSource(SAMPLE_RATE, CHANNELS)
    out_track = rtc.LocalAudioTrack.create_audio_track("clean-voice", source)
    await room.local_participant.publish_track(
        out_track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )

    tasks = {}

    async def relay(track: rtc.Track, identity: str):
        stream = rtc.AudioStream.from_track(
            track=track,
            sample_rate=SAMPLE_RATE,
            num_channels=CHANNELS,
            noise_cancellation=noise_cancellation.BVC(),
        )
        log.info("relay started for %s", identity)
        try:
            async for event in stream:
                await source.capture_frame(event.frame)
        finally:
            await stream.aclose()
            log.info("relay stopped for %s", identity)

    def start_if_guest(track: rtc.Track, participant: rtc.RemoteParticipant):
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if not participant.identity.startswith("guest_"):
            return
        if track.sid in tasks:
            return
        tasks[track.sid] = asyncio.create_task(relay(track, participant.identity))

    @room.on("track_subscribed")
    def on_track_subscribed(track, publication, participant):
        start_if_guest(track, participant)

    @room.on("track_unsubscribed")
    def on_track_unsubscribed(track, publication, participant):
        task = tasks.pop(track.sid, None)
        if task:
            task.cancel()

    for participant in room.remote_participants.values():
        for publication in participant.track_publications.values():
            if publication.track is not None:
                start_if_guest(publication.track, participant)


if __name__ == "__main__":
    cli.run_app(server)
