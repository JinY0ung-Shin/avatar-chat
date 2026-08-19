# STT engine image. The official vllm-openai image ships WITHOUT the [audio]
# extra, so every /v1/audio/transcriptions request dies at decode time with an
# ImportError ("install vllm[audio]") — this derived image adds exactly that
# extra on top of the pinned base. soundfile alone would NOT be enough: the
# composer records audio/webm (Chrome/Edge), which libsndfile cannot read, and
# vLLM decodes that container — and resamples EVERY clip to the model's sample
# rate — through PyAV (av). The [audio] extra carries both, plus soxr/scipy.
#
# Keep the TWO pins below (FROM tag, pip pin) in lockstep with each other and
# with the `image:` tag of docker-compose.yml's stt service; bump all three in
# one commit and re-run the deploy-time transcription check in README.md.
# Build happens on a machine WITH internet (the deploy host has none):
#   docker compose --profile stt build stt
FROM vllm/vllm-openai:v0.27.1

# Corporate-mirror args, same pattern as the app Dockerfile (empty = upstream
# PyPI); --trusted-host is added only when set, for an HTTP mirror with a
# self-signed cert. Proxy vars are Docker built-ins and pass through on their
# own.
#
# The FOUR packages are vllm 0.27.1's [audio] extra spelled out (mistral_common
# is already in the base image), pinned to the resolution that extra produces —
# deliberately NOT `pip install "vllm[audio]==0.27.1"`: naming vllm makes pip
# re-resolve its whole tree, which DOWNGRADES the nvidia-nccl the base image
# intentionally upgraded past torch's own pin (2.30.7 → 2.29.7 when this was
# written). On a base bump, re-derive these pins from the new tag's [audio]
# extra. The trailing self-test asserts the imports the transcription path
# needs, so a broken mirror fails the build here rather than at the first mic
# click.
ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=
ARG AUDIO_DEPS="soundfile==0.14.0 av==18.1.0 soxr==1.1.0 scipy==1.18.0"
RUN if [ -n "$PIP_INDEX_URL" ]; then \
      pip install --no-cache-dir --index-url "$PIP_INDEX_URL" ${PIP_TRUSTED_HOST:+--trusted-host "$PIP_TRUSTED_HOST"} $AUDIO_DEPS; \
    else \
      pip install --no-cache-dir $AUDIO_DEPS; \
    fi \
  && python3 -c "import soundfile, av, soxr; print('audio extras OK:', 'soundfile', soundfile.__version__, '/ av', av.__version__)"
