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

  function count(videoId) {
    let n = 0;
    for (const client of clients) if (client.videoId === videoId) n += 1;
    return n;
  }

  function broadcast(event, data) {
    for (const client of clients) send(client, event, data);
  }

  function broadcastPresence(videoId) {
    if (!videoId) return;
    broadcast('presence', { videoId, count: count(videoId) });
  }

  return {
    count,
    broadcast,
    broadcastPresence,
    handle(req, res, videoId, canSee) {
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
      const client = { res, videoId, canSee };
      clients.add(client);
      send(client, 'hello', { videoId, count: count(videoId) });
      broadcastPresence(videoId);

      req.on('close', () => {
        clients.delete(client);
        broadcastPresence(videoId);
      });
    },
  };
}
