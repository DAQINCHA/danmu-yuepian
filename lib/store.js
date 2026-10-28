import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const EMPTY = () => ({ version: 1, videos: [], comments: [], annotations: [] });

/**
 * 单文件 JSON 存储。数据量是「几支片 + 几百条评论」的量级，
 * 用 node:sqlite 属于杀鸡用牛刀，JSON + 原子写更透明。
 */
export function createStore(file) {
  let state = EMPTY();
  let timer = null;
  let dirty = false;

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { ...EMPTY(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] 读取 ${file} 失败，按空库启动：${err.message}`);
      state = EMPTY();
    }
  }

  function writeSync() {
    if (!dirty) return;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      console.error(`[store] 写入失败：${err.message}`);
    }
  }

  function save() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeSync();
    }, 120);
  }

  const byTime = (a, b) => a.time - b.time || a.createdAt - b.createdAt;
  // 老库里的评论没有 replies 字段，读出去时补成空数组，不改动磁盘上的旧数据
  const withReplies = (c) => (Array.isArray(c.replies) ? c : { ...c, replies: [] });

  return {
    load,
    flush: writeSync,

    listVideos() {
      return [...state.videos].sort((a, b) => b.createdAt - a.createdAt);
    },
    findVideo(id) {
      return state.videos.find((v) => v.id === id) || null;
    },
    insertVideo(video) {
      state.videos.push(video);
      save();
      return video;
    },
    updateVideo(id, patch) {
      const video = state.videos.find((v) => v.id === id);
      if (!video) return null;
      Object.assign(video, patch);
      save();
      return video;
    },
    deleteVideo(id) {
      state.videos = state.videos.filter((v) => v.id !== id);
      state.comments = state.comments.filter((c) => c.videoId !== id);
      state.annotations = state.annotations.filter((a) => a.videoId !== id);
      save();
    },

    listComments(videoId) {
      return state.comments.filter((c) => c.videoId === videoId).sort(byTime).map(withReplies);
    },
    findComment(id) {
      const comment = state.comments.find((c) => c.id === id);
      return comment ? withReplies(comment) : null;
    },
    insertComment(input) {
      const comment = { id: randomUUID(), createdAt: Date.now(), done: false, replies: [], ...input };
      state.comments.push(comment);
      save();
      return comment;
    },
    updateComment(id, patch) {
      const comment = state.comments.find((c) => c.id === id);
      if (!comment) return null;
      Object.assign(comment, patch);
      save();
      return comment;
    },
    /** 在一条弹幕下追加回复，返回更新后的整条弹幕 */
    addReply(commentId, input) {
      const comment = state.comments.find((c) => c.id === commentId);
      if (!comment) return null;
      if (!Array.isArray(comment.replies)) comment.replies = [];
      const reply = { id: randomUUID(), createdAt: Date.now(), ...input };
      comment.replies.push(reply);
      save();
      return { comment, reply };
    },
    deleteReply(commentId, replyId) {
      const comment = state.comments.find((c) => c.id === commentId);
      if (!comment || !Array.isArray(comment.replies)) return null;
      const before = comment.replies.length;
      comment.replies = comment.replies.filter((r) => r.id !== replyId);
      if (comment.replies.length === before) return null;
      save();
      return comment;
    },
    deleteComment(id) {
      const before = state.comments.length;
      state.comments = state.comments.filter((c) => c.id !== id);
      if (state.comments.length !== before) save();
      return state.comments.length !== before;
    },

    listAnnotations(videoId) {
      return state.annotations.filter((a) => a.videoId === videoId).sort(byTime);
    },
    findAnnotation(id) {
      return state.annotations.find((a) => a.id === id) || null;
    },
    insertAnnotation(input) {
      const annotation = { id: randomUUID(), createdAt: Date.now(), done: false, ...input };
      state.annotations.push(annotation);
      save();
      return annotation;
    },
    updateAnnotation(id, patch) {
      const annotation = state.annotations.find((a) => a.id === id);
      if (!annotation) return null;
      Object.assign(annotation, patch);
      save();
      return annotation;
    },
    deleteAnnotation(id) {
      const before = state.annotations.length;
      state.annotations = state.annotations.filter((a) => a.id !== id);
      if (state.annotations.length !== before) save();
      return state.annotations.length !== before;
    },

    stats() {
      return {
        videos: state.videos.length,
        comments: state.comments.length,
        annotations: state.annotations.length,
      };
    },
  };
}
