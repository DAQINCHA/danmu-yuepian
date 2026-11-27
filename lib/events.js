/**
 * SSE 广播中心。审片场景只需要服务端单向推送（谁发了弹幕 / 画笔），
 * 上行用普通 POST 就够，不必自己实现 WebSocket 握手。
 */
export function createEventHub() {
  const clients = new Set();

  const heartbeat = setInterval(() => {
    for (const client of clients) client.res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref?.();

  function send(client, event, data) {
    // 带了 projectId 的事件只发给能看这个项目的人（锁着又没通行证的收不到）
    if (data && data.projectId && client.canSee && !client.canSee(data.projectId)) return;
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  // 人数口径统一走 snapshot：同一人多个标签页只算一次，未署名按连接数算
  function count(videoId) {
    return snapshot(videoId).count;
  }

  /** 某支片当前的在线情况：按入场顺序去重的署名 + 未署名连接数 */
  function snapshot(videoId) {
    if (!videoId) return { videoId: '', count: 0, viewers: [], anon: 0 };
    const viewers = [];
    let anon = 0;
    for (const client of clients) {
      if (client.videoId !== videoId) continue;
      if (client.viewer) {
        if (!viewers.includes(client.viewer)) viewers.push(client.viewer);
      } else {
        anon += 1;
      }
    }
    // 人数口径和名单一致：同一人开多个标签页只算一个，未署名按连接数算
    const count = viewers.length + anon;
    return { videoId, count, viewers, anon };
  }

  function broadcast(event, data) {
    for (const client of clients) send(client, event, data);
  }

  function broadcastPresence(videoId) {
    if (!videoId) return;
    broadcast('presence', snapshot(videoId));
  }

  return {
    count,
    snapshot,
    broadcast,
    broadcastPresence,
    handle(req, res, videoId, canSee, viewer = '') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);

      // canSee 按连接时的通行证算一份；解锁后客户端会重连，够用
      const client = { res, videoId, canSee, viewer: String(viewer || '').trim().slice(0, 16) };
      clients.add(client);
      send(client, 'hello', snapshot(videoId));
      broadcastPresence(videoId);

      req.on('close', () => {
        clients.delete(client);
        broadcastPresence(videoId);
      });
    },
  };
}
