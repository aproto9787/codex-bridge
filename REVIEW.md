# codex-bridge 종합 리뷰 결과 (재토론 반영)

**리뷰 일자**: 2026-03-06
**대상**: `/root/codex-bridge/codex-bridge.mjs` (1413줄)
**환경**: WSL2, 단일 사용자(root), 세션 수분~수십분
**프로세스**: 리뷰어 3명 → 비판자 2명 재토론 → 최종 합의

---

## 최종 우선순위

### Tier 1: 즉시 수정 (실제 버그/핵심 결함)

| # | 이슈 | 라인 | 심각도 | 비고 |
|---|------|------|--------|------|
| **A** | steerChain이 전체 턴 완료를 block + currentTurn null 참조 | 1078-1088, 1258-1267 | **CRITICAL** | #2+#10 병합. 양방향 통신 핵심 결함 |
| **B** | findTuiBin() null → existsSync(null) TypeError | 474 | **HIGH** | 1줄 수정. TUI 없는 환경에서 crash |
| **C** | 시그널 핸들러 중복 진입 | 1302-1326 | **HIGH** | shuttingDown 가드 추가 |
| **D** | inbox read-markAsRead TOCTOU | 550-568 | **MEDIUM** | 단일 lock 통합. 확률 낮지만 정확한 수정 |

### Tier 2: 다음 릴리스 (유의미한 개선)

| # | 이슈 | Impact/Effort | 비고 |
|---|------|---------------|------|
| **E** | mtime 캐시로 불필요한 inbox 파싱 방지 | Medium/Easy | 3줄 추가, 부작용 없음 |
| **F** | MAX_RESULT_BYTES 상한 설정 (5MB) | Medium/Easy | OOM 방어 |
| **G** | pendingSteerQueue 턴 완료 후 자동 drain | Medium/Easy | 메시지 유실 방지 |
| **H** | passthroughToClaude 시그널 핸들링 | Medium/Easy | SIGTERM 미전파 수정 |
| **I** | withLock stale 판정 PID 기반 | Medium/Medium | lock 안정성 개선 |
| **J** | TUI delta 재직렬화 회피 | Medium/Medium | 고빈도 stringify 제거 |
| **K** | 적응형 폴링 (fs.watch 없이) | Low/Easy | 유휴 시 2000ms → 수신 시 100ms |
| **L** | ensureInbox TOCTOU | Low/Easy | `{ flag: "wx" }` 1줄 |

### Tier 3: 장기 개선

| # | 이슈 | 비고 |
|---|------|------|
| M | app-server crash 후 재연결 | 복잡도 높음 (상태 복원), 별도 설계 필요 |
| N | withLock exponential backoff | 이론적 개선, 현재도 문제 없음 |
| O | ensureInbox 경로 캐시 | 2줄, 미미한 효과 |
| P | import 위치 정리 (L713 readdirSync) | 코드 정리 |
| Q | MAX_RESULT_BYTES 단위 (바이트 vs 문자) | F와 함께 수정 |
| R | readdirSync → readdir 비동기 | 1회 호출, 실질 영향 없음 |

### 삭제 (과잉 대응 / 환경 부적합 / 기술적 오류)

| 원래 # | 이슈 | 삭제 이유 |
|--------|------|-----------|
| #3 | TMUX_PANE injection | spawnSync는 shell 미경유, 단일 사용자 환경 |
| #4 | inbox RCE 체인 | root 단일 사용자 → inbox 쓸 수 있으면 이미 RCE |
| #5 | 바이너리 경로 미검증 | env 조작 = 이미 게임 오버. 화이트리스트는 사용성 파괴 |
| #8 | activeTurnPromise rejection | .then(resolve, reject)이 이미 양쪽 잡음. 방어적이나 실효성 낮음 |
| #9 | handleFatal rejection | 발생 확률 극히 낮음, Node 22 기본 경고만 출력 |
| #15 | /tmp 로그 symlink | 단일 root, 위협 모델 해당 없음 |
| #16 | 파일 권한 0600 | 단일 root, 다른 사용자 없음 |
| #17 | env 화이트리스트 | 신뢰 바이너리에 env 전달은 정상, regression 위험 |
| #25 | JSON compact | 디버깅 편의성 > 수 바이트 절약 |
| #30 | log injection | 단일 사용자, 로그 자동파싱 없음 |
| #31 | prototype pollution | 기술적 오류: JSON.parse는 prototype pollution 안 함 |
| #32 | logStream 버퍼링 | 기본값 이미 64KB |
| #33 | Date 최적화 | 마이크로 최적화, 측정 불가 |
| #34 | diff split 최적화 | split 비용 무시 가능 |
| #35 | killMyPane async | 종료 직전 spawnSync가 오히려 안전 |

---

## 상세 수정 방안

### A. steerChain + currentTurn null (CRITICAL)

**문제**: `runTurn()`의 steer 경로가 `this.currentTurn.completion`을 반환 → steerChain이 턴 전체를 block → 실시간 steer 무력화. 또한 await 중 turn 완료로 currentTurn=null → TypeError.

**수정**: `runTurn()` 내부 steer 경로를 리팩터링. completion 대신 steer ACK만 반환.

```js
// runTurn() 내부 — steer 경로 (L1078-1088)
if (this.currentTurn) {
  const activeTurnId = this.activeTurnId || this.currentTurn.turnId;
  if (!activeTurnId) {
    throw new Error("active turn exists but turn id is unknown");
  }
  await this.sendRequest("turn/steer", {
    threadId: this.threadId,
    expectedTurnId: activeTurnId,
    input: [{ type: "text", text: `[STEER]\n${prompt}` }],
  });
  return; // completion을 반환하지 않음 — steer ACK만
}
```

steerChain 호출부(L1258-1267)는 그대로 유지:
```js
steerChain = steerChain.then(async () => {
  try {
    await session.runTurn(taskText);  // 이제 steer ACK만 await
  } catch (steerErr) {
    log("STEER-ERR", steerErr.message);
    pendingSteerQueue.push(taskText);
  }
});
```

**주의**: `runTurn` 반환 타입이 steer(void) vs 새 턴(completion promise)으로 달라짐. 호출부에서 반환값을 사용하는 곳 확인 필요.

### B. findTuiBin null (HIGH)

```js
// L474: 기존
if (existsSync(tuiBin)) {
// 수정
if (tuiBin && existsSync(tuiBin)) {
```

### C. 시그널 핸들러 가드 (HIGH)

```js
// L1302 위에 추가
let shuttingDown = false;

// L1304의 핸들러 시작부
process.on(sig, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  // ... 기존 정리 로직 ...
});
```

### D. inbox read+mark 통합 (MEDIUM)

```js
// readUnreadMessages + markAsRead를 하나로 통합
async function readAndMarkUnread(inboxPath) {
  return withLock(inboxPath, async () => {
    const messages = await readInbox(inboxPath);
    const unread = [];
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].read) {
        unread.push({ index: i, msg: messages[i] });
        messages[i].read = true;
      }
    }
    if (unread.length > 0) {
      await writeFile(inboxPath, JSON.stringify(messages, null, 2), "utf-8");
    }
    return unread;
  });
}
```

pollLoop에서 `readUnreadMessages` + `markAsRead` 호출을 `readAndMarkUnread` 단일 호출로 교체.

### E. mtime 캐시

```js
// 모듈 스코프에 추가
let lastInboxMtime = 0;

// readAndMarkUnread 또는 pollLoop에서
const st = await fsStat(inboxPath).catch(() => null);
if (!st || st.mtimeMs === lastInboxMtime) return [];
lastInboxMtime = st.mtimeMs;
// ... 기존 파싱 로직 ...
```

### F. MAX_RESULT_BYTES 상한

```js
// L14
const MAX_RESULT_BYTES = 5 * 1024 * 1024; // 5MB
```

### G. pendingSteerQueue 자동 drain

```js
// handleTurnResult/handleTurnError 마지막에 추가
if (pendingSteerQueue.length > 0) {
  const queued = pendingSteerQueue.splice(0);
  log("STEER-DRAIN", `auto-draining ${queued.length} queued messages`);
  const drainPrompt = queued.join("\n\n---\n\n");
  activeTurnPromise = session.runTurn(drainPrompt);
  activeTurnPromise.then(handleTurnResult, handleTurnError);
}
```

---

## 재토론에서 뒤집힌 판정

| 원래 | 재토론 후 | 이유 |
|------|-----------|------|
| #3 CRITICAL | 삭제 | spawnSync는 shell 미경유 — injection 아님 |
| #4 HIGH | 삭제 | root 단일 사용자 환경에서 위협 모델 부재 |
| #5 HIGH | 삭제 | env 조작 가능 = 이미 게임 오버 |
| #1 CRITICAL → #D MEDIUM | 격하 | 실제 발생 확률 매우 낮음 (500ms 폴링 주기 대비 μs 윈도우) |
| #11 High/Easy | Low/Easy | 500ms 폴링 비용 미미, fs.watch는 과잉 |
| #14 High/Medium | 삭제 | 0.2초 1회, 수분 세션에서 무의미 |
| #27 Low | Medium 격상 | 초당 수십~수백 delta → measurable CPU 절약 |
| #31 Low | 삭제 | JSON.parse는 prototype pollution 안 함 (기술적 오류) |
