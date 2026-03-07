# Codex Native Agent Team + CLI UI — Implementation Plan v2

> 2026-03-07 | 2차 토론(plan-critic, strategy-advisor, pragmatist) 반영
> v1 대비 변경: 7단계→3단계, 40+파일→~10 핵심 모듈, in-memory first
> 재평가(source-verifier, consistency-checker, feasibility-reviewer) 반영: 매핑 보완, LOC 상향, 시간 현실화
>
> **Phase 1 완료** (c92d64f 구현 + 264951d 핫픽스, 22 테스트 통과)
> 검증 결과 및 미수정 백로그: `/root/codex-team-v2/CHANGELOG.md` 참조

---

## 토론에서 드러난 v1 문제점

1. **Stage 1/2/3 경계가 실제 코드와 안 맞음**: handleNotification()과 pollLoop()에서 정규화·transport·런타임이 한 덩어리
2. **이벤트 파이프라인 과잉**: NormalizedEvent→BusFrame→Reducer→UiStore→Panel 5계층은 과도. "공유 해석기 1개 + 소비자 2~3개"면 충분
3. **Stage 2 UDS는 Stage 3 없이 dead code**: 독립 출하 불가능
4. **LOC 추정 낙관적**: 특히 app-server-client, TUI 쪽
5. **포크 전략 필수**: codex-bridge.mjs는 동결, 새 제품을 옆에 만들어야

## 핵심 결정

| 항목 | 결정 |
|---|---|
| **포크 전략** | git worktree (`v2/native-team` 브랜치) |
| **codex-bridge.mjs** | 동결 (Claude 호환 adapter, 수정 최소화) |
| **새 엔트리** | `bin/codex-team.mjs` (독립 제품) |
| **IPC (Phase 1)** | in-memory EventEmitter (UDS는 Phase 3) |
| **TUI** | terminal-kit (설치 검증 완료) |
| **Storage (Phase 1)** | in-memory (SQLite는 Phase 3) |
| **단계 수** | 3 phases (MVP → 완성 → 확장) |
| **핵심 모듈 수** | ~10개 (v1의 40+에서 축소) |

## 환경 검증 완료 (pragmatist 실측)

- terminal-kit: npm install 성공, Node 22.22.0 호환
- better-sqlite3: npm install 성공, :memory: DB 동작 확인
- node:sqlite: 존재하지만 experimental 경고

---

## 포크 전략

### 시작 절차

```bash
# 1. 현재 상태 커밋
cd /root/codex-bridge
git add -A
git commit -m "chore: save current state before v2 fork"

# 2. worktree 생성
git worktree add ../codex-team-v2 -b v2/native-team

# 3. v2에서 작업
cd ../codex-team-v2
```

### 런타임 플래그 (안전장치)

```bash
CODEX_RUNTIME=legacy|core    # legacy=기존 bridge, core=새 captain
CODEX_UI=legacy|tk            # legacy=blessed viewer, tk=terminal-kit
```

### 원칙

- `codex-bridge.mjs`는 Claude 호환 adapter로 동결. 최소한의 import 변경만 허용
- 새 모듈은 `lib/` + `bin/`에 작성
- 공유 코드는 검증 후에만 추출 (섣부른 공유 금지)
- 마일스톤마다 커밋, 되돌릴 수 있는 경계 유지

---

## Phase 1: MVP — Captain + Workers + TUI (핵심)

> 목표: `codex-team start "prompt"` → foreground 단일 프로세스 → 2~4 worker live stream in terminal-kit

### 아키텍처

```
codex-team start "<prompt>"
    |
    v
+-- 단일 Node.js 프로세스 -----------------+
|                                           |
|  CaptainRuntime (in-memory)               |
|    ├── WorkerHost[0] → AppServerClient    |
|    ├── WorkerHost[1] → AppServerClient    |
|    ├── WorkerHost[2] → AppServerClient    |
|    └── EventEmitter (in-process)          |
|                                           |
|  terminal-kit TUI                         |
|    ├── Captain Panel (left)               |
|    ├── Worker Panels (right, 2x2 grid)    |
|    └── Status Bar (bottom)                |
+-------------------------------------------+
```

### 모듈 (Blocker B2/B3/B4 반영)

| # | File | LOC | Purpose |
|---|---|---|---|
| 1 | `lib/core/types.mjs` | ~80 | NormalizedEvent, WorkerState, TurnResult 타입 |
| 2 | `lib/core/logger.mjs` | ~50 | 간단한 구조화 로거 |
| 3 | `lib/codex/app-server-client.mjs` | ~350 | Transport+State만: spawn, JSON-RPC, approval, emit raw notifications |
| 4 | `lib/codex/notification-parser.mjs` | ~200 | **Stateless** pure parser: method/params → NormalizedEvent[] |
| 5 | `lib/codex/turn-accumulator.mjs` | ~120 | **Stateful**: NormalizedEvent → TurnResult (상태 머신) |
| 6 | `lib/runtime/worker-host.mjs` | ~350 | Worker 래퍼: steer queue, turn lifecycle, state management |
| 7 | `lib/runtime/captain-runtime.mjs` | ~300 | Supervisor: worker pool, 작업 배정, 결과 수집 |
| 8 | `lib/ui/tk-screen.mjs` | ~500 | terminal-kit 루트 화면: 레이아웃, 렌더 루프, 입력 |
| 9 | `lib/ui/worker-panel.mjs` | ~250 | Worker 패널: ring buffer, 스트리밍 표시, 독립 스크롤 |
| 10 | `lib/ui/captain-panel.mjs` | ~150 | Captain 패널: 작업 큐, 상태, 비용 |
| 11 | `bin/codex-team.mjs` | ~180 | CLI 엔트리: arg parse, captain start, TUI attach, signal drain |
|    | `test/helpers/fake-app-server.mjs` | ~200 | Stub app-server (transcript replay) |
|    | `test/*.test.mjs` | ~500 | 핵심 테스트 |
|    | **Total** | **~3,230** | |

### Blocker 수정 사항

**B2: app-server-client 경계 재설계**
```
app-server-client 소유 (transport+state만):
  ✓ spawn codex app-server, JSON-RPC plumbing
  ✓ approval auto-accept
  ✓ stdout buffer/parse
  ✓ thread/start, turn/start
  ✓ emit raw notifications (파싱 안함)
  ✓ close/cleanup
  ✓ currentChild → 인스턴스 변수 (전역 아님)

상위 레이어(WorkerHost)가 소유:
  ✗ steer queue
  ✗ turn result 조립 (turn-accumulator 사용)
  ✗ sessionInfo → WorkerHost 인스턴스 변수
  ✗ viewerProc → 제거 (TUI가 대체)
  ✗ signal handling → bin/codex-team
```

**B3: notification 3분할**
```
기존 (두 switch문이 다른 역할):
  renderNotificationANSI (L194) — 12개 case, UI 출력
  handleNotification (L1033) — 4개 case, turn 상태 추적

새 구조:
  notification-parser.mjs — stateless pure: method/params → NormalizedEvent[]
  turn-accumulator.mjs — stateful: NormalizedEvent → TurnResult
  TUI → NormalizedEvent를 직접 소비 (별도 render layer 불필요)
```

**B4: fan-out → 단일 작업 모드**
Phase 1은 fan-out을 하지 않음. 대신:
- 기본: 1 worker에 1 prompt (단일 작업 실행 + 관찰)
- `--workers N`: N개 워커 생성, 사용자가 TUI에서 각 워커에 개별 작업 배정
- fan-out/split/LLM planner는 Phase 2~3에서 도입

### 코드 추출 매핑 (codex-bridge.mjs → 새 모듈)

```
codex-bridge.mjs 현재 라인  →  새 위치
─────────────────────────────────────────────
L145-391  renderNotificationANSI    →  제거 (TUI가 NormalizedEvent 직접 소비)
L393-408  normalizeSandboxPolicy    →  app-server-client.mjs (내부 유틸)
L410-452  renderNotification        →  제거 (viewer-bridge는 legacy에 남김)
L454-543  TUI viewer spawn          →  제거 (새 TUI가 대체)
L545-607  inbox 파일 I/O            →  제거 (Phase 1은 in-memory, legacy bridge에 잔류)
L658-725  leader 통신/idle/shutdown →  제거 (Phase 1은 독립 실행, legacy bridge에 잔류)
L746-752  tmux 제어                 →  제거 (새 TUI가 대체)
L755-779  task auto-complete        →  제거 (legacy bridge에 잔류)
L801-895  AppServerSession start    →  app-server-client.mjs (transport만)
L897-960  JSON-RPC send/request     →  app-server-client.mjs
L962-1031 stdout parse, approval    →  app-server-client.mjs
L1033-1114 handleNotification       →  notification-parser.mjs (파싱) + turn-accumulator.mjs (상태)
L1117-1155 handleFatal/handleClose  →  app-server-client.mjs
L1157-1241 runTurn/interrupt/close  →  worker-host.mjs (turn RPC만, steer queue 아님)
L1245-1458 pollLoop                 →  worker-host.mjs (턴 관리 + steer queue)
                                       + captain-runtime.mjs (배정)
                                       제거: inbox protocol, mode/idle 필터링 (legacy 전용)
L1460-1489 signal handling          →  bin/codex-team.mjs (SIGTERM/SIGINT drain)
L1491-1535 passthroughToClaude      →  잔류 (codex-bridge.mjs Claude 호환 전용)
L1561-1564 tmux select-pane         →  제거 (새 TUI가 대체)

env/model 정책:
  L838     process.env 전달         →  app-server-client.mjs (allowlist 필터링)
  L864-865 model 미전달 주석        →  app-server-client.mjs (명시적 model 지정 옵션)
  L874-883 sessionInfo 저장         →  app-server-client.mjs start() 반환값

전역 변수 소유권 이동:
  currentChild    →  AppServerClient 인스턴스 (this.child)
  sessionInfo     →  AppServerClient start() 반환값 → WorkerHost가 보관
  viewerProc      →  제거 (TUI가 대체)
  running         →  WorkerHost 인스턴스 상태
  shuttingDown    →  bin/codex-team.mjs (프로세스 레벨)
  codexEffort     →  AppServerClient constructor 옵션
  lastInboxMtime  →  제거 (inbox 폐기)
  currentPollMs   →  제거 (inbox polling 폐기)
  lastIdleSentAt  →  제거 (leader 프로토콜 폐기)
  logStream       →  logger.mjs (공유 로거)
```

### 핵심 인터페이스

```js
// lib/codex/app-server-client.mjs — transport+state만
export class AppServerClient extends EventEmitter {
  constructor({ cwd, effort, model })
  start()              → Promise<SessionInfo>   // 반환값으로 SessionInfo 전달 (전역 아님)
  startTurn(prompt)    → Promise<void>          // idle 상태에서 turn/start RPC
  steerTurn(prompt)    → Promise<void>          // active 상태에서 turn/steer RPC
  interruptTurn()      → Promise<boolean>
  close()              → Promise<void>
  // Events: 'notification' ({method, params}), 'close', 'error'
  // 주의: turnComplete는 여기서 emit하지 않음 (turn-accumulator가 담당)
}

// lib/codex/notification-parser.mjs — stateless pure function
export function parseNotification(method, params, ctx) → NormalizedEvent[]
// ctx: { workerId }
// 순수 변환만. 상태 없음.

// lib/codex/turn-accumulator.mjs — stateful 상태 머신
export class TurnAccumulator {
  onEvent(evt: NormalizedEvent) → TurnResult | null  // null이면 아직 진행중
  reset()
}

// lib/runtime/worker-host.mjs — steer queue + turn lifecycle 소유
export class WorkerHost extends EventEmitter {
  constructor({ workerId, cwd, effort })
  assignTask(prompt)   → Promise<TurnResult>
  steer(prompt)        → Promise<void>
  interrupt()          → Promise<void>
  shutdown()           → Promise<void>
  // Events: 'event' ({workerId, event: NormalizedEvent}), 'stateChange'
  // 내부: AppServerClient + parseNotification() + TurnAccumulator 조합
}

// lib/runtime/captain-runtime.mjs — 워커 풀 관리
export class CaptainRuntime extends EventEmitter {
  constructor({ teamName, workerCount, cwd, effort })
  start()              → Promise<void>
  assignToWorker(workerId, prompt) → Promise<TurnResult>
  shutdown()           → Promise<void>
  getWorkers()         → Map<string, WorkerState>
  // Events: 'workerEvent', 'workerStateChange'
}

// lib/ui/tk-screen.mjs
export class TkScreen {
  constructor({ captainRuntime })
  start()              → Promise<void>
  shutdown()           → Promise<void>
}

// lib/ui/worker-panel.mjs
export class WorkerPanel {
  constructor({ ringSize: 5000 })
  appendDelta(text)    → void
  draw(term, box)      → void
  scrollUp(n)          → void
  scrollDown(n)        → void
}
```

### 작업 배정 전략 (Phase 1: 단일 작업 모드)

Phase 1에서는 **fan-out 하지 않음**:
- 기본: `codex-team start "prompt"` → 1 worker에 1 prompt 실행
- `--workers N`: N개 워커 생성, 각각에 개별 작업 배정 가능 (TUI에서 선택)
- 중복 작업 방지: 한 워커에 한 작업만
- LLM planner / fan-out / split은 Phase 2~3에서 도입

### TUI 레이아웃

```
+-- Terminal (min 100 cols) ----------------+
|                                           |
| Captain (30%)    | Workers (70%)          |
| +-----------+    | +--------+ +--------+  |
| | Status    |    | | W1     | | W2     |  |
| | Workers: 4|    | | stream | | stream |  |
| | Active: 2 |    | | ring   | | ring   |  |
| | Tokens: 8k|    | +--------+ +--------+  |
| | Cost: $0.1|    | +--------+ +--------+  |
| |           |    | | W3     | | W4     |  |
| | [Queue]   |    | | stream | | stream |  |
| | task 1: ✓ |    | | ring   | | ring   |  |
| | task 2: ▶ |    | +--------+ +--------+  |
| +-----------+    |                        |
|                                           |
| Status: 4 workers | tokens: 8.2k | $0.12 |
+-------------------------------------------+
```

- N≤4: 2x2 grid
- N>4: focus panel + compact list (Tab으로 전환)
- Terminal < 100 cols: 단일 focus panel
- 구현 방식: manual layout 좌표 계산 + `terminal.grabInput()` (Layout/Document 모델 미사용)
- 패널별 스크롤: 자체 `lines[]` + `scrollOffset` + `follow` 상태 (ScreenBuffer는 보조 옵션)

### 키바인딩

| Key | Action |
|---|---|
| Tab / Shift+Tab | 다음/이전 워커 포커스 |
| j / k | 포커스된 패널 스크롤 |
| f | follow mode 토글 (자동 스크롤) |
| q / Ctrl+C | graceful shutdown |
| i | interrupt 현재 포커스 워커 |

### 의존성

| Package | Type | Status |
|---|---|---|
| `terminal-kit` | npm (pure JS) | 설치 검증 완료 |

### 전제 조건

- Node.js 22+ (ESM, node:test 지원)
- `codex` CLI 0.111.0+ (PATH에 존재, `codex app-server` 서브커맨드 지원)
- 인증된 Codex CLI 상태 (`~/.codex/auth.json` 또는 `CODEX_API_KEY`)
- TTY 환경 (terminal-kit는 raw mode 필요)
- 기본 `--workers 2`, 상한 4 (heavy shell task 동시 실행 시 CPU 포화 가능)

### 완료 기준

**기능 (Phase 1 모듈로 달성):**
- [ ] `codex-team start "hello" --workers 2` → 2 워커 live stream TUI
- [ ] 각 워커 패널에서 독립 스크롤
- [ ] Tab으로 포커스 전환
- [ ] q로 graceful shutdown (모든 워커 drain)

**회귀 (포크 전략으로 보장):**
- [ ] 기존 codex-bridge.mjs Claude 팀원 모드 깨지지 않음 (smoke test)

**검증:**
- [ ] `node --test` 통과 (package.json test script + fake-app-server 필요)

### 테스트 전략

- **fake-app-server**: JSON-RPC transcript를 replay하는 stub
- **notification-parser + turn-accumulator**: fixture 기반 golden test
- **worker-host**: stub client로 turn lifecycle 테스트
- **captain-runtime**: 2 worker spawn → 작업 배정 → 결과 수집 통합 테스트
- **TUI**: 화면 렌더링은 수동 검증 (terminal-kit spike에서 확인)

---

## Phase 2: 완성 — 운영 가능한 Captain + 안정화

> 목표: Captain 제어 API, 큐 시스템, crash recovery, TUI lifecycle 분리, 설정 파일
> 설계 토론 결과: full UDS (captain↔worker 소켓)는 Phase 3로 이월. Worker는 in-process 유지.
> 핵심 가치: "TUI 닫아도 팀이 안 죽고, worker 죽으면 자동 복구"

### 모듈 (신규 + 변경)

| # | File | Type | LOC | Purpose |
|---|---|---|---|---|
| 1 | `lib/runtime/captain-control.mjs` | **신규** | ~200 | Captain 공용 제어 API: dispatch/steer/interrupt/snapshot + 큐 관리 |
| 2 | `lib/core/config.mjs` | **신규** | ~120 | 팀 설정 파일 로드 (CLI > env > config > defaults) |
| 3 | `lib/core/event-logger.mjs` | **신규** | ~100 | Event NDJSON 로거 (canonical envelope, Phase 3 SQLite 입력 호환) |
| 4 | `bin/codex-tui.mjs` | **신규** | ~80 | 독립 TUI attach 엔트리 (같은 프로세스 내 captain에 연결) |
| 5 | `lib/runtime/captain-runtime.mjs` | 변경 | +100 | worker crash recovery (backoff 재시작, generation ID), lifecycle 정리 (M8) |
| 6 | `lib/runtime/worker-host.mjs` | 변경 | +60 | generation ID, restart 지원, 에러→재시작 전이 |
| 7 | `lib/ui/tk-screen.mjs` | 변경 | +80 | `_workers` 직접 접근 제거 → CaptainControl 인터페이스 의존, 큐 UI |
| 8 | `lib/ui/captain-panel.mjs` | 변경 | +40 | 큐 영역 표시 (M1 해소) |
| 9 | `bin/codex-team.mjs` | 변경 | +60 | `q` = TUI만 종료 / `Q` = 팀 전체 종료, `attach` 서브커맨드 |
|   | `test/*.test.mjs` | 변경 | +150 | crash recovery, queue, control API 테스트 |
|   | **Total** | | **~990** | |

### Captain 공용 제어 API (captain-control.mjs)

```js
export class CaptainControl {
  constructor(captainRuntime)

  // 작업 배정 — idle이면 즉시 시작, busy면 큐에 적재
  dispatch(workerId, prompt)    → { queued: boolean, position?: number }

  // 스티어 — active turn에 주입, idle이면 에러
  steer(workerId, prompt)       → void

  // 인터럽트
  interrupt(workerId)           → Promise<boolean>

  // 전체 스냅샷 (attach 시 초기 동기화용)
  snapshot()                    → { workers: Map<string, WorkerState>, queue: QueueEntry[] }

  // 이벤트 구독 (TUI/로거 등)
  on('workerEvent' | 'workerStateChange' | 'queueChange', handler)
}
```

TkScreen은 CaptainControl만 의존. captainRuntime._workers 직접 접근 제거.

### Captain 큐 시스템

```
사용자 → TUI 'a' 키 → dispatch(workerId, prompt)
  ├─ worker idle → 즉시 assignTask()
  └─ worker busy → 큐에 적재 → worker idle 시 자동 dequeue

큐 표시: captain-panel에 큐 영역 추가
  task 1: w0 ▶ "fix auth bug"
  task 2: w1 ⏳ "add tests"
```

### Worker Crash Recovery

```
worker 'error' 또는 'close' 감지
  → generation ID 증가
  → backoff 재시작 (1s, 2s, 4s, 8s, max 30s)
  → 3연속 실패 시 'dead' 상태 → TUI에 표시, 수동 재시작 대기
  → 재시작 성공 시 backoff 리셋
  → 큐에 남은 작업 자동 재배정
```

### TUI Lifecycle 분리

```
현재: q/Ctrl+C → screen.shutdown() → runtime.shutdown() → 프로세스 종료
변경:
  q     → TUI만 종료 (captain 계속 실행, background)
  Q     → 팀 전체 종료 (drain + cleanup)
  codex-team attach <team> → 실행 중인 captain에 TUI 재연결
```

구현: captain을 별도 프로세스로 분리하지 않고, 같은 프로세스에서 TUI detach/reattach.
TUI 없이도 captain이 worker들을 관리하고 큐를 처리.

### Config 파일

```json
// ~/.codex/teams/<team>/config.json
{
  "workerCount": 2,
  "effort": "high",
  "model": null,
  "sandbox": "danger-full-access",
  "approvalPolicy": "never",
  "logDir": "~/.codex/teams/<team>/logs",
  "maxRestartAttempts": 3,
  "restartBackoffMs": [1000, 2000, 4000, 8000, 30000]
}
```

우선순위: CLI flag > 환경변수 > config 파일 > 기본값

### 구조화 로그 + Event NDJSON

```
~/.codex/teams/<team>/
  logs/
    captain.log          # 구조화 JSON 라인 로그
  runtime/
    events.ndjson        # canonical event envelope (Phase 3 SQLite 입력 호환)
```

Event envelope 포맷:
```json
{"v":1,"ts":"...","workerId":"w0","gen":1,"kind":"agent_delta","data":{...}}
```

`gen` (generation) 필드로 crash 전/후 이벤트 구분.

### 의존 관계

```
captain-control.mjs ← tk-screen.mjs (제어 API만 의존)
captain-control.mjs → captain-runtime.mjs (내부 위임)
captain-runtime.mjs → worker-host.mjs (crash recovery 확장)
config.mjs ← captain-runtime.mjs, bin/codex-team.mjs
event-logger.mjs ← captain-control.mjs (이벤트 기록)
```

### 완료 기준

- [ ] `codex-team start "prompt"` → captain + TUI, `q`로 TUI만 종료
- [ ] `codex-team attach` → 실행 중인 captain에 TUI 재연결
- [ ] worker crash 시 자동 재시작 (backoff)
- [ ] busy worker에 dispatch → 큐 적재 → idle 시 자동 실행
- [ ] 설정 파일로 worker 수/effort/model 조정
- [ ] events.ndjson에 모든 이벤트 기록

### Phase 3로 이월된 항목

- `bin/codex-worker.mjs` (독립 worker 프로세스)
- Captain↔Worker UDS transport (uds-bus-server/client, ndjson-codec)
- Daemon supervisor + PID file
- SQLite persistence + recovery-manager

---

## Phase 3: 확장 — UDS + SQLite + Daemon + Claude Reviewer

> 목표: 독립 worker 프로세스, UDS transport, persistence, daemon 모드, LLM planner, Claude review, budget

### 추가 모듈

| File | LOC | Purpose |
|---|---|---|
| `lib/transport/uds-bus-server.mjs` | ~180 | Unix domain socket 서버 (Phase 2에서 이월) |
| `lib/transport/uds-bus-client.mjs` | ~140 | Unix domain socket 클라이언트 |
| `lib/transport/ndjson-codec.mjs` | ~80 | NDJSON encode/decode |
| `bin/codex-worker.mjs` | ~120 | 독립 worker 프로세스 엔트리 (Phase 2에서 이월) |
| `lib/storage/session-store-sqlite.mjs` | ~340 | SQLite CRUD |
| `lib/storage/migrations/001_init.sql` | ~60 | 4테이블 스키마 (workers, tasks, runs, kv) |
| `lib/runtime/daemon-supervisor.mjs` | ~260 | Daemonize, PID file, attach/stop |
| `lib/runtime/recovery-manager.mjs` | ~220 | DB ↔ live worker 상태 조정 |
| `lib/review/claude-reviewer.mjs` | ~220 | `claude -p` one-shot review |
| `lib/policy/budget-policy.mjs` | ~180 | Token/cost 제한 |
| `lib/runtime/llm-planner.mjs` | ~300 | Codex 기반 작업 분해/배정 |
| `bin/codex-team.mjs` 확장 | +80 | status/stop 서브커맨드 |
| **Total** | **~2,180** | |

### SQLite 스키마 (4 테이블)

```sql
CREATE TABLE workers (
  id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'pending',
  pid INTEGER, session_info TEXT, registered_at TEXT, last_heartbeat_at TEXT
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, prompt TEXT, status TEXT DEFAULT 'pending',
  owner_worker_id TEXT, result TEXT, created_at TEXT, completed_at TEXT
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id),
  worker_id TEXT REFERENCES workers(id), turn_id TEXT,
  status TEXT DEFAULT 'running', token_usage TEXT, cost_usd REAL,
  started_at TEXT, completed_at TEXT
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
```

### Claude Reviewer

```
실행 조건:
  - run 완료 + 실제 변경 있음 + budget 허용 + claude 바이너리 존재
호출:
  claude -p --output-format stream-json (env -u CLAUDECODE)
입력:
  목표 + 변경 파일 목록 + diff 요약 + 워커 결과 + 알려진 리스크
출력:
  ReviewResult { findings[], severity, approved }
비용:
  기본 1회만. blocking finding + 실제 수정 시 1회 재호출 허용
```

### LLM Planner (Captain 지능화)

Phase 1의 단일 작업 모드를 Codex 기반 동적 분해로 확장:
- 사용자 프롬프트 → Codex가 서브태스크 분해
- 서브태스크별 워커 배정
- 워커 결과 기반 재계획 (blocked/failed 시)
- deterministic 코드 + LLM 하이브리드 (큐/상태/재시도는 코드, 분해/판단은 LLM)

### 완료 기준

- [ ] `codex-team start` → daemon + auto-attach
- [ ] `codex-team attach/status/stop` 동작
- [ ] Captain 재시작 시 SQLite에서 상태 복원
- [ ] 완료된 run에 Claude review 자동 실행 (조건 충족 시)
- [ ] Budget 초과 시 신규 작업/리뷰 차단

---

## Phase 간 관계

```
Phase 1 (MVP)                Phase 2 (운영)              Phase 3 (확장)
──────────────               ──────────────              ──────────────
단일 프로세스                  단일 프로세스 유지            멀티 프로세스 (UDS)
in-memory EventEmitter       + Captain 제어 API           + SQLite 영속
terminal-kit TUI (in-proc)   + TUI lifecycle 분리         + daemon 모드
단일 작업 모드               + Captain 큐 시스템           + LLM planner
수동 shutdown                + crash recovery             + Claude reviewer
                             + config + 구조화 로그        + budget policy
~3,230 LOC                   +990 LOC ≈ 4,220            +2,180 LOC ≈ 6,400
```

### 각 Phase 독립성 보장

- **Phase 1 완료 후**: 독립 실행 가능한 제품. `codex-team start "prompt"` 동작
- **Phase 2 완료 후**: 운영 가능한 Captain. crash recovery, 큐, TUI detach, 설정 파일
- **Phase 3 완료 후**: 완전한 네이티브급. UDS 멀티프로세스, 지능형 배정, 리뷰, 비용 관리

### codex-bridge.mjs와의 관계

```
Phase 1: bridge 동결, 새 제품은 bin/codex-team.mjs에서 독립 시작
Phase 2: bridge에서 app-server-client.mjs를 import할 수 있음 (공유 시작)
Phase 3: bridge가 captain-runtime을 내부적으로 사용할 수 있음 (통합 옵션)
         단, bridge의 Claude 호환 entry contract는 영구 보존
```

---

## 최종 파일 구조

```
codex-bridge/                       (= codex-team-v2 worktree)
  bin/
    codex-team.mjs                   # 새 CLI 엔트리 (~180 LOC)
    codex-worker.mjs                 # 독립 worker 프로세스 (Phase 2, ~120 LOC)
    codex-tui.mjs                    # 독립 TUI attach (Phase 2, ~80 LOC)
  lib/
    core/
      types.mjs                      # 공유 타입 (~80 LOC)
      logger.mjs                     # 구조화 로거 (~50 LOC)
      config.mjs                     # 팀 설정 (Phase 2, ~100 LOC)
    codex/
      app-server-client.mjs          # Codex app-server 클라이언트 (~350 LOC)
      notification-parser.mjs        # Stateless pure parser: method/params → NormalizedEvent[] (~200 LOC)
      turn-accumulator.mjs           # Stateful 상태 머신: NormalizedEvent → TurnResult (~120 LOC)
    runtime/
      captain-runtime.mjs            # Supervisor (~300 LOC)
      worker-host.mjs                # Worker 래퍼 (~350 LOC)
      daemon-supervisor.mjs          # Phase 3 (~260 LOC)
      recovery-manager.mjs           # Phase 3 (~220 LOC)
      llm-planner.mjs                # Phase 3 (~300 LOC)
    transport/
      uds-bus-server.mjs             # Phase 2 (~180 LOC)
      uds-bus-client.mjs             # Phase 2 (~140 LOC)
      ndjson-codec.mjs               # Phase 2 (~80 LOC)
    storage/
      session-store-sqlite.mjs       # Phase 3 (~340 LOC)
      migrations/001_init.sql        # Phase 3 (~60 LOC)
    ui/
      tk-screen.mjs                  # terminal-kit 메인 (~500 LOC)
      worker-panel.mjs               # Worker 패널 + ring buffer (~250 LOC)
      captain-panel.mjs              # Captain 상태 패널 (~150 LOC)
    review/
      claude-reviewer.mjs            # Phase 3 (~220 LOC)
    policy/
      budget-policy.mjs              # Phase 3 (~180 LOC)
  test/
    helpers/
      fake-app-server.mjs            # Stub (~200 LOC)
    notification-parser.test.mjs
    turn-accumulator.test.mjs
    worker-host.test.mjs
    captain-runtime.test.mjs
  codex-bridge.mjs                   # 동결 — Claude 호환 adapter
  codex-tui-viewer.mjs               # 동결 — CODEX_UI=legacy fallback
  package.json
  IMPLEMENTATION_PLAN.md
```

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Claude teammate 모드 깨짐 | codex-bridge.mjs 동결, 새 코드는 별도 엔트리 |
| terminal-kit 멀티패널 성능 | Phase 1 초기에 4패널 fake-stream 스파이크 실행 |
| 병렬 worker 메모리 | 2→4 점진적 증가, free -h 모니터링 |
| Stage 경계 붕괴 | 3 phase로 축소, 각 phase 내부에서만 결합 허용 |
| 과도한 추상화 | "공유 해석기 + 소비자" 패턴, 5계층 파이프라인 금지 |
| LLM planner 불확실성 | Phase 1은 단일 작업 모드, Phase 3에서 LLM planner 점진 도입 |

---

## 즉시 실행 가능한 첫 작업 (Phase 1 kickoff)

```bash
# 0. worktree 생성
git add -A && git commit -m "chore: pre-v2 checkpoint"
git worktree add ../codex-team-v2 -b v2/native-team
cd ../codex-team-v2

# 1. terminal-kit 4패널 스파이크 (~1-1.5시간)
#    fake stream → 4 worker panel → 리사이즈/스크롤 확인
#    이게 안 되면 전체 계획 재검토
#    구현: manual layout + terminal.grabInput()

# 2. notification-parser + turn-accumulator 추출 (~1.5-2시간)
#    codex-bridge.mjs의 두 switch문을 parser(stateless) + accumulator(stateful)로 3분할

# 3. app-server-client 추출 (~2-3시간)
#    AppServerSession을 독립 EventEmitter로
#    steerTurn() 분리, start() → SessionInfo 반환

# 4. worker-host + captain-runtime (~3-4시간)
#    in-memory 단일 작업 모드, 2 worker 실행

# 5. terminal-kit TUI 통합 (~4-6시간)
#    captain panel + worker grid + status bar
#    패널별 ring buffer + 독립 스크롤 + 포커스

# 6. 테스트 + 정리 (~2-3시간)
#
# 총 예상: 14-20시간 (집중 작업 1.5-2일)
```
