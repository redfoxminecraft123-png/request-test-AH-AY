'use strict';

const NEW_HEADER = 'لقيت فيديوهات جديدة:';
const NOTHING_FOUND = 'ملقيتش حاجة';
const MAX_VIDEOS_PER_MESSAGE = 50;

function groupVideos(videos) {
  const teachers = new Map();

  for (const video of videos) {
    const teacherKey = String(video.teacherId);
    if (!teachers.has(teacherKey)) {
      teachers.set(teacherKey, {
        name: video.teacherName || `مدرس ${video.teacherId}`,
        courses: new Map(),
      });
    }
    const teacher = teachers.get(teacherKey);

    const courseKey = String(video.courseId);
    if (!teacher.courses.has(courseKey)) {
      teacher.courses.set(courseKey, {
        title: video.courseTitle || `كورس ${video.courseId}`,
        lessons: new Map(),
      });
    }
    const course = teacher.courses.get(courseKey);

    const lessonKey = String(video.lessonId);
    if (!course.lessons.has(lessonKey)) {
      course.lessons.set(lessonKey, {
        title: video.lessonTitle || `درس ${video.lessonId}`,
        videos: [],
      });
    }
    course.lessons.get(lessonKey).videos.push(video);
  }

  return teachers;
}

function buildTeacherMessage(teacher, label) {
  const courseBlocks = [];

  for (const course of teacher.courses.values()) {
    const lines = [`*${course.title}*`];
    for (const lesson of course.lessons.values()) {
      lines.push(`${lesson.title}:`);
      const sorted = [...lesson.videos].sort(
        (a, b) => Number(a.sessionId) - Number(b.sessionId),
      );
      for (const video of sorted) {
        lines.push(`- ${video.title}`);
        lines.push(video.link);
      }
      lines.push('');
    }
    courseBlocks.push(lines.join('\n').trim());
  }

  return [`*${label}*`, ...courseBlocks].join('\n\n');
}

function chunkVideos(videos, size) {
  const chunks = [];
  for (let index = 0; index < videos.length; index += size) {
    chunks.push(videos.slice(index, index + size));
  }
  return chunks;
}

function messagesForRun({ firstRun, force, videos, newVideos }) {
  const source = force ? videos : newVideos;
  if (!Array.isArray(source) || source.length === 0) return [NOTHING_FOUND];
  if (firstRun && !force) return [NOTHING_FOUND];

  const messages = [];

  for (const teacher of groupVideos(source).values()) {
    const teacherVideos = [];
    for (const course of teacher.courses.values()) {
      for (const lesson of course.lessons.values()) {
        teacherVideos.push(...lesson.videos);
      }
    }

    const parts = chunkVideos(teacherVideos, MAX_VIDEOS_PER_MESSAGE);
    for (let index = 0; index < parts.length; index += 1) {
      const part = groupVideos(parts[index]).values().next().value;
      const label = parts.length > 1 ? `${part.name} - part ${index + 1}` : part.name;
      messages.push(`${NEW_HEADER}\n\n${buildTeacherMessage(part, label)}`);
    }
  }

  return messages;
}

function splitMessage(text, maxLength = 50_000) {
  if (!Number.isFinite(maxLength) || maxLength < 1_000) {
    throw new Error('maxLength must be at least 1000');
  }
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function messageChunks(text, maxLength = 50_000) {
  const chunks = splitMessage(text, maxLength);
  return chunks.map((chunk, index) =>
    index === 0 ? chunk : `(تكملة ${index + 1}/${chunks.length})\n${chunk}`,
  );
}

module.exports = {
  NEW_HEADER,
  NOTHING_FOUND,
  messagesForRun,
  splitMessage,
  messageChunks,
};
