import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const EMPTY = () => ({ version: 1, projects: [], videos: [], comments: [], annotations: [] });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 旧库没有 projects / 视频没有 projectId。空 projectId 就是「未分类」，不删任何视频、弹幕、画笔。 */
function migrateProjects(file, parsed) {
  const videos = Array.isArray(parsed.videos) ? parsed.videos : [];
  const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
  const annotations = Array.isArray(parsed.annotations) ? parsed.annotations : [];
  const needs = !Array.isArray(parsed.projects)
    || videos.some((video) => video && !Object.prototype.hasOwnProperty.call(video, 'projectId'));
  if (!needs) return parsed;

  const before = { videos: videos.length, comments: comments.length, annotations: annotations.length };
  const backup = `${file}.${stamp()}.bak`;
  fs.copyFileSync(file, backup);

  if (!Array.isArray(parsed.projects)) parsed.projects = [];
  for (const video of videos) {
    if (!video || typeof video !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(video, 'projectId') || video.projectId === '') video.projectId = null;
  }
  const after = {
    videos: parsed.videos.length,
    comments: parsed.comments.length,
    annotations: parsed.annotations.length,
  };
  if (before.videos !== after.videos || before.comments !== after.comments || before.annotations !== after.annotations) {
    console.error(`[store] 迁移中止，数量对不上：${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return parsed;
  }
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  console.log(`[store] 已迁移到项目库：视频 ${after.videos}、弹幕 ${after.comments}、画笔 ${after.annotations}，备份 ${backup}`);
  return parsed;
}

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
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = migrateProjects(file, JSON.parse(raw));
      state = { ...EMPTY(), ...parsed };
      if (!Array.isArray(state.projects)) state.projects = [];
      for (const video of state.videos) {
        if (video && !video.projectId) video.projectId = null;
      }
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
  // 老库里的评论 / 标注没有 replies 字段，读出去时补成空数组，不改动磁盘上的旧数据
  const withReplies = (c) => (Array.isArray(c.replies) ? c : { ...c, replies: [] });

  /** 弹幕和画笔标注共用的回复读写；key = 'comments' | 'annotations' */
  function pushReply(key, id, input) {
    const item = state[key].find((x) => x.id === id);
    if (!item) return null;
    if (!Array.isArray(item.replies)) item.replies = [];
    const reply = { id: randomUUID(), createdAt: Date.now(), ...input };
    item.replies.push(reply);
    save();
    return { item, reply };
  }
  function dropReply(key, id, replyId) {
    const item = state[key].find((x) => x.id === id);
    if (!item || !Array.isArray(item.replies)) return null;
    const before = item.replies.length;
    item.replies = item.replies.filter((r) => r.id !== replyId);
    if (item.replies.length === before) return null;
    save();
    return item;
  }

  return {
    load,
    flush: writeSync,

    listProjects() {
      return [...state.projects].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    findProject(id) {
      return state.projects.find((p) => p.id === id) || null;
    },
    createProject(name) {
      const now = Date.now();
      const project = { id: randomUUID(), name, createdAt: now, updatedAt: now };
      state.projects.push(project);
      save();
      return project;
    },
    renameProject(id, name) {
      const project = state.projects.find((p) => p.id === id);
      if (!project) return null;
      project.name = name;
      project.updatedAt = Date.now();
      save();
      return project;
    },
    /** 删除项目只摘掉文件夹，视频回到未分类，文件和弹幕都留着 */
    deleteProject(id) {
      const project = state.projects.find((p) => p.id === id);
      if (!project) return null;
      let moved = 0;
      for (const video of state.videos) {
        if (video.projectId === id) {
          video.projectId = null;
          moved += 1;
        }
      }
      state.projects = state.projects.filter((p) => p.id !== id);
      save();
      return { project, moved };
    },
    touchProject(id) {
      const project = state.projects.find((p) => p.id === id);
      if (!project) return null;
      project.updatedAt = Date.now();
      save();
      return project;
    },

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
    /** 在一条弹幕 / 画笔标注下追加回复，返回 { item, reply }，item 是更新后的整条 */
    addReply(kind, id, input) {
      return pushReply(kind === 'annotation' ? 'annotations' : 'comments', id, input);
    },
    deleteReply(kind, id, replyId) {
      return dropReply(kind === 'annotation' ? 'annotations' : 'comments', id, replyId);
    },
    deleteComment(id) {
      const before = state.comments.length;
      state.comments = state.comments.filter((c) => c.id !== id);
      if (state.comments.length !== before) save();
      return state.comments.length !== before;
    },

    listAnnotations(videoId) {
      return state.annotations.filter((a) => a.videoId === videoId).sort(byTime).map(withReplies);
    },
    findAnnotation(id) {
      const annotation = state.annotations.find((a) => a.id === id);
      return annotation ? withReplies(annotation) : null;
    },
    insertAnnotation(input) {
      const annotation = { id: randomUUID(), createdAt: Date.now(), done: false, replies: [], ...input };
      state.annotations.push(annotation);
      save();
      return annotation;
    },
    updateAnnotation(id, patch) {
      const annotation = state.annotations.find((a) => a.id === id);
      if (!annotation) return null;
      Object.assign(annotation, patch);
      save();
      return withReplies(annotation);
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
