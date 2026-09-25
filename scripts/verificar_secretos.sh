#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: ejecutar este control dentro del repositorio Git." >&2
  exit 2
fi

fallo=0
rutas_sensibles='(^|/)(\.env($|\.)|[^/]*(secret|credential|private)[^/]*\.(h|hpp|json|ya?ml|txt)|[^/]*\.(pem|key|p12|sqlite3?(-wal|-shm|-journal)?|db(-wal|-shm|-journal)?)|[^/]*\.(bin|elf|map|zip|tgz|tar(\.gz)?|log|ndjson))$'
rutas_permitidas='(^|/)(\.env\.example|[^/]*secrets\.example\.h)$'

while IFS= read -r archivo; do
  if printf '%s\n' "$archivo" | grep -Eiq "$rutas_sensibles" \
      && ! printf '%s\n' "$archivo" | grep -Eiq "$rutas_permitidas"; then
    echo "ERROR: archivo sensible rastreado por Git: $archivo" >&2
    fallo=1
  fi
done < <(git ls-files)

patron_secretos="BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|sk-[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|#define[[:space:]]+[A-Za-z0-9_]*(api[_-]?key|device[_-]?key|password|passwd|secret|token)[A-Za-z0-9_]*[[:space:]]+[\"'][^\"'[:space:]]{8,}|(api[_-]?key|device[_-]?key|password|passwd|secret|token)[A-Za-z0-9_-]*(\[\])?[[:space:]]*(=|:)[[:space:]]*[\"'][^\"'[:space:]]{8,}"

if git grep -lIiE "$patron_secretos" -- . \
    ':(exclude)scripts/verificar_secretos.sh'; then
  echo "ERROR: posible secreto encontrado en archivos rastreados." >&2
  fallo=1
fi

if (( fallo != 0 )); then
  echo "No hagas push. Quita el secreto del indice y rota cualquier credencial expuesta." >&2
  exit 1
fi

echo "Control de secretos aprobado."
