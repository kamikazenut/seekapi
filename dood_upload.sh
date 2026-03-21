#!/usr/bin/env bash
set -u
set -o pipefail

# --- CONFIG ---
ULTRA_USER="gfxnick"
ULTRA_PASS="Dogman.1"
ULTRA_HOST="gfxnick.phoebe.usbx.me"
SEEK_API_TOKEN="0b429dec3a3a7ed121a3544e"
SEEK_API_BASE="https://seekstreaming.com"
BIG_TOKEN="nDvwP7Kp0w1YBj2ZAG5x"
LOG_FILE="${HOME}/combined_upload.log"
LOCK_FILE="/tmp/upload_queue.lock"
QUEUE_WAIT_SECONDS=14400
SEEK_POLL_ATTEMPTS=90
SEEK_POLL_INTERVAL_SECONDS=20

BIG_CALLBACK_URL="https://fmoviez.online/v1/callbacks/bigshare"
SEEK_CALLBACK_URL="https://fmoviez.online/v1/callbacks/seekstream"
CALLBACK_AUTH_TOKEN=""

log() {
  echo "$(date -Is) $1" >> "$LOG_FILE"
}

post_callback() {
  local callback_url="$1"
  local payload="$2"
  local curl_args=(-s -X POST "$callback_url" -H "Content-Type: application/json")

  if [[ -n "$CALLBACK_AUTH_TOKEN" ]]; then
    curl_args+=(-H "Authorization: Bearer ${CALLBACK_AUTH_TOKEN}" -H "x-callback-token: ${CALLBACK_AUTH_TOKEN}")
  fi

  curl "${curl_args[@]}" -d "$payload" > /dev/null
}

FILE_INPUT="${1:-}"
TORRENT_NAME="${2:-}"
TORRENT_HASH="${3:-}"

# --- QUEUE SYSTEM ---
exec 200>$LOCK_FILE
log "Queue: $TORRENT_NAME is checking the line..."
if ! flock -x -w "$QUEUE_WAIT_SECONDS" 200; then
  log "Queue ERROR: $TORRENT_NAME timed out after ${QUEUE_WAIT_SECONDS}s. Skipping."
  exit 1
fi

# --- UPLOAD FUNCTIONS ---
upload_bigshare() {
  local target_file="$1"
  local clean_name=$(basename "$target_file")
  log "Bigshare: Starting $clean_name..."
  local srv=$(curl -sL --max-time 30 "https://bigshare.io/api/upload/server?api_token=$BIG_TOKEN")
  local url=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read() or "{}").get("result",""))' <<< "$srv")
  [[ -z "$url" || "$url" == "None" ]] && url="https://bigshare.io/api/videos/file"
  local up=$(curl -sL --max-time 1200 -F "api_token=$BIG_TOKEN" -F "file=@${target_file}" "$url")
  local code=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); o=d.get("data") or d.get("result") or d; print(o.get("file_code") or o.get("id") or "")' <<< "$up")
  if [[ -n "$code" ]]; then
    local embed="https://bigshare.io/embed-$code.html"
    local payload=$(python3 -c "import json,sys; print(json.dumps({'torrentHash': sys.argv[1], 'torrentName': sys.argv[2], 'contentPath': sys.argv[3], 'fileCode': sys.argv[4], 'embedUrl': sys.argv[5]}))" "$TORRENT_HASH" "$TORRENT_NAME" "$target_file" "$code" "$embed")
    post_callback "$BIG_CALLBACK_URL" "$payload"
    log "Bigshare callback for $clean_name sent."
  fi
}

upload_seek() {
  local target_file="$1"
  local clean_name=$(basename "$target_file")
  log "Seek: Starting Pull for $clean_name..."
  local ABS_PATH=$(readlink -f "$target_file")
  local WEB_REL_PATH=$(echo "$ABS_PATH" | sed 's|.*/downloads/|downloads/|')
  local ENC_PATH=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$WEB_REL_PATH")
  local REMOTE_URL="https://${ULTRA_USER}:${ULTRA_PASS}@${ULTRA_HOST}/${ENC_PATH}"
  local JSON_BODY=$(python3 -c "import json,sys; print(json.dumps({'url': sys.argv[1], 'name': sys.argv[2]}))" "$REMOTE_URL" "$clean_name")
  local resp=$(curl -sL --max-time 30 -X POST -H "api-token: ${SEEK_API_TOKEN}" -H "Content-Type: application/json" -d "$JSON_BODY" "${SEEK_API_BASE}/api/v1/video/advance-upload")
  local task_id=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print(d.get("id") or d.get("data",{}).get("id") or "")' <<< "$resp")
  [[ -z "$task_id" ]] && { log "Seek ERROR for $clean_name: $resp"; return 0; }

  for ((i=1; i<=SEEK_POLL_ATTEMPTS; i++)); do
    local status_json=$(curl -sL --max-time 20 -H "api-token: ${SEEK_API_TOKEN}" "${SEEK_API_BASE}/api/v1/video/advance-upload/${task_id}")
    local id=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); vids=d.get("videos") or d.get("data",{}).get("videos") or []; print(vids[0] if isinstance(vids,list) and vids else "")' <<< "$status_json")
    local status=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); root=d.get("data") or d; print((root.get("status") or "").strip())' <<< "$status_json")
    local error=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); root=d.get("data") or d; print((root.get("error") or "").strip())' <<< "$status_json")
    if [[ -n "$id" ]]; then
      local embed="https://321movies.embedseek.xyz/#$id"
      local payload=$(python3 -c "import json,sys; print(json.dumps({'torrentHash': sys.argv[1], 'torrentName': sys.argv[2], 'contentPath': sys.argv[3], 'fileCode': sys.argv[4], 'embedUrl': sys.argv[5]}))" "$TORRENT_HASH" "$TORRENT_NAME" "$target_file" "$id" "$embed")
      post_callback "$SEEK_CALLBACK_URL" "$payload"
      log "Seek success for $clean_name: $id"
      return 0
    fi

    local status_lc=$(echo "$status" | tr '[:upper:]' '[:lower:]')
    if [[ -n "$error" || "$status_lc" == *fail* || "$status_lc" == *error* ]]; then
      log "Seek FAIL for $clean_name: status=${status:-unknown} error=${error:-none}"
      return 0
    fi

    sleep "$SEEK_POLL_INTERVAL_SECONDS"
  done

  log "Seek TIMEOUT for $clean_name after $((SEEK_POLL_ATTEMPTS * SEEK_POLL_INTERVAL_SECONDS))s without a video id."
  return 0
}

# --- IMPROVED FILTERING ---
log "--- STARTING: $TORRENT_NAME ---"

# Extract Season string (e.g., S01) from Torrent Name
SEASON_TAG=$(echo "$TORRENT_NAME" | grep -ioP 'S\d+' | head -n 1 || echo "")

# Find all video files first
mapfile -t ALL_VIDEOS < <(find "$FILE_INPUT" -type f \( -iname "*.mkv" -o -iname "*.mp4" -o -iname "*.avi" \) -size +150M | grep -iv "sample")

# Now filter the list
VIDEO_FILES=()
for f in "${ALL_VIDEOS[@]}"; do
    if [[ -n "$SEASON_TAG" ]]; then
        # If a season tag exists, ONLY keep files that contain it
        if [[ "$f" =~ "$SEASON_TAG" ]]; then
            VIDEO_FILES+=("$f")
        fi
    else
        # If no season tag in torrent name, keep everything
        VIDEO_FILES+=("$f")
    fi
done

# Sort the final list
IFS=$'\n' VIDEO_FILES=($(sort -V <<<"${VIDEO_FILES[*]}"))
unset IFS

if [ ${#VIDEO_FILES[@]} -eq 0 ]; then
    log "ERROR: No matching video files found (Filter: $SEASON_TAG, Size: >150MB)"
    exit 1
fi

log "Found ${#VIDEO_FILES[@]} file(s) matching $SEASON_TAG. Processing..."

for FILE in "${VIDEO_FILES[@]}"; do
    upload_bigshare "$FILE"
    upload_seek "$FILE"
done

log "--- ALL FINISHED: $TORRENT_NAME ---"
