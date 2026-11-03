'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectVideos, extractLessons, dedupeCourses } = require('../src/collect');

const logger = { info() {}, warn() {}, error() {} };

test('deduplicates courses and revisions by id', () => {
  const result = dedupeCourses(
    [{ id: 1, title: 'course' }],
    [{ id: 1, title: 'duplicate' }, { id: 2, title: 'revision' }],
  );
  assert.deepEqual(result.map((item) => item.id), [1, 2]);
  assert.equal(result[0].title, 'course');
});

test('extracts flat and unit-nested lessons without duplicates', () => {
  const lessons = extractLessons({
    lessons: [{ id: 1, title: 'flat' }],
    units: [{ lessons: [{ id: 1, title: 'duplicate' }, { id: 2, title: 'nested' }] }],
  });
  assert.deepEqual(lessons.map((item) => item.id), [1, 2]);
});

test('collects only video sessions and keeps going after a lesson error', async () => {
  const calls = [];
  const api = {
    async fetchTeacherDetails(teacherId) {
      calls.push(['teacher', teacherId]);
      return {
        data: {
          id: teacherId,
          name: 'Teacher One',
          courses: [{ id: 10, title: 'Course 10' }, { id: 11, title: 'Course 11' }],
          revisions: [{ id: 10, title: 'Course 10 duplicate' }, { id: 12, title: 'Course 12' }],
        },
      };
    },
    async fetchCourseDetails(courseId) {
      calls.push(['course', courseId]);
      if (courseId === 10) {
        return {
          data: {
            course_info: { title: 'Course Ten' },
            lessons: [{ id: 100, title: 'Lesson 100' }],
            units: [{ lessons: [{ id: 101, title: 'Lesson 101' }] }],
          },
        };
      }
      if (courseId === 11) {
        return { data: { lessons: [{ id: 110, title: 'Lesson 110' }] } };
      }
      return { data: { lessons: [] } };
    },
    async fetchLessonSessions(lessonId, courseId) {
      calls.push(['lesson', lessonId, courseId]);
      if (lessonId === 100) {
        return {
          data: {
            title: 'Lesson 100',
            sessions: [
              { id: 1, type: 1, title: 'Video 1', link: 'https://example.com/1' },
              { id: 2, type: 2, title: 'PDF', link: 'https://example.com/pdf' },
              { id: 3, type: 1, title: 'No link', link: '' },
            ],
          },
        };
      }
      if (lessonId === 101) {
        return {
          data: {
            title: 'Lesson 101',
            sessions: [{ id: 4, type: 1, title: 'Video 4', link: 'https://example.com/4' }],
          },
        };
      }
      throw new Error('lesson unavailable');
    },
  };

  const result = await collectVideos({ api, teacherIds: [1], logger });

  assert.deepEqual(result.videos.map((item) => item.sessionId), ['1', '4']);
  assert.equal(result.videos[0].courseTitle, 'Course Ten');
  assert.equal(result.videos[1].lessonTitle, 'Lesson 101');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, 'lesson');
  assert.equal(result.errors[0].id, 110);
  assert.equal(calls.filter(([kind, id]) => kind === 'course' && id === 10).length, 1);
});

test('reports a teacher failure without throwing', async () => {
  const api = {
    async fetchTeacherDetails() {
      throw new Error('network down');
    },
  };
  const result = await collectVideos({ api, teacherIds: [1], logger });
  assert.deepEqual(result.videos, []);
  assert.equal(result.teachers.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, 'teacher');
});
