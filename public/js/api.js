async function request(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  getConfig: () => request('GET', '/api/config'),
  listVideos: () => request('GET', '/api/videos'),
  listProjects: () => request('GET', '/api/projects'),
  createProject: (name) => request('POST', '/api/projects', { name }),
  renameProject: (id, name) => request('PATCH', `/api/projects/${id}`, { name }),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),
  getVideo: (id) => request('GET', `/api/videos/${id}`),
  patchVideo: (id, patch) => request('PATCH', `/api/videos/${id}`, patch),
  moveVideo: (id, projectId) => request('PATCH', `/api/videos/${id}`, { projectId: projectId || null }),
  deleteVideo: (id) => request('DELETE', `/api/videos/${id}`),
  addComment: (id, comment) => request('POST', `/api/videos/${id}/comments`, comment),
  setCommentDone: (id, done) => request('PATCH', `/api/comments/${id}`, { done }),
  // 只能改自己署名的弹幕，服务端按 author 核对
  editComment: (id, text, author) => request('PATCH', `/api/comments/${id}`, { text, author }),
  deleteComment: (id) => request('DELETE', `/api/comments/${id}`),
  // kind = 'comment' | 'annotation'，弹幕和画笔标注的回复接口同构
  addReply: (kind, id, reply) => request('POST', `/api/${kind}s/${id}/replies`, reply),
  deleteReply: (kind, id, replyId, author) => request(
    'DELETE',
    `/api/${kind}s/${id}/replies/${replyId}?author=${encodeURIComponent(author || '')}`,
  ),
  addAnnotation: (id, annotation) => request('POST', `/api/videos/${id}/annotations`, annotation),
  setAnnotationDone: (id, done) => request('PATCH', `/api/annotations/${id}`, { done }),
  setAnnotationRange: (id, start, end) => request('PATCH', `/api/annotations/${id}`, { start, end }),
  deleteAnnotation: (id) => request('DELETE', `/api/annotations/${id}`),
};

/**
 * 上传走 XHR：需要 upload 进度事件，fetch 目前给不了。
 * 文件名等信息放自定义头，body 直接是 File 本体，服务端原样落盘。
 */
export function uploadVideo(file, meta, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Title', encodeURIComponent(meta.title || ''));
    xhr.setRequestHeader('X-Uploader', encodeURIComponent(meta.uploader || ''));
    xhr.setRequestHeader('X-Duration', String(meta.duration || 0));
    xhr.setRequestHeader('X-Fps', String(meta.fps || 25));
    if (meta.newProjectName) xhr.setRequestHeader('X-New-Project-Name', encodeURIComponent(meta.newProjectName));
    else if (meta.projectId) xhr.setRequestHeader('X-Project-Id', encodeURIComponent(meta.projectId));

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });

    xhr.addEventListener('load', () => {
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText || '{}');
      } catch {
        payload = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || `上传失败 (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('上传中断，检查网络或服务是否还在运行')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));

    xhr.send(file);
  });
}

export function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    const done = (value) => {
      URL.revokeObjectURL(url);
      probe.removeAttribute('src');
      resolve(value);
    };
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => {
      done(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 0);
    });
    probe.addEventListener('error', () => done(0));
    setTimeout(() => done(0), 8000);
    probe.src = url;
  });
}
