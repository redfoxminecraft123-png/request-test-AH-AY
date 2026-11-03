'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNewVideosMessage,
  messageForRun,
  splitMessage,
  messageChunks,
  NEW_HEADER,
  NOTHING_FOUND,
} = require('../src/message');

function video(overrides) {
  return {
    sessionId: '1',
    teacherId: 1,
    teacherName: 'Teacher One',
    courseId: 10,
    courseTitle: 'Course One',
    lessonId: 100,
    lessonTitle: 'Lesson One',
    title: 'Video One',
    link: 'https://example.com/one',
    ...overrides,
  };
}

test('returns the nothing-found message when there are no videos', () => {
  assert.equal(buildNewVideosMessage([]), NOTHING_FOUND);
  assert.equal(buildNewVideosMessage(null), NOTHING_FOUND);
});

test('groups videos by teacher, course and lesson', () => {
  const text = buildNewVideosMessage([
    video({ sessionId: '2', title: 'Second video', link: 'https://example.com/two' }),
    video({ sessionId: '1', title: 'First video', link: 'https://example.com/one' }),
    video({
      sessionId: '3',
      teacherId: 2,
      teacherName: 'Teacher Two',
      courseId: 20,
      courseTitle: 'Course Two',
      lessonId: 200,
      lessonTitle: 'Lesson Two',
      title: 'Third video',
      link: 'https://example.com/three',
    }),
  ]);

  assert.ok(text.startsWith(NEW_HEADER));
  assert.match(text, /\*Teacher One\*/);
  assert.match(text, /\*Course One\*/);
  assert.match(text, /Lesson One:/);
  assert.match(text, /- First video\nhttps:\/\/example\.com\/one/);
  assert.match(text, /- Second video\nhttps:\/\/example\.com\/two/);
  assert.match(text, /\*Teacher Two\*/);
  assert.match(text, /- Third video\nhttps:\/\/example\.com\/three/);

  assert.ok(text.indexOf('First video') < text.indexOf('Second video'));
  assert.ok(text.indexOf('Teacher One') < text.indexOf('Teacher Two'));
});

test('force send lists every video even when nothing is new', () => {
  const all = [video({ sessionId: '1' }), video({ sessionId: '2', title: 'Video Two' })];
  const text = messageForRun({ firstRun: false, force: true, videos: all, newVideos: [] });
  assert.ok(text.startsWith(NEW_HEADER));
  assert.match(text, /Video One/);
  assert.match(text, /Video Two/);
});

test('normal runs keep the nothing-found and new-only behaviour', () => {
  const all = [video({ sessionId: '1' }), video({ sessionId: '2', title: 'Video Two' })];
  assert.equal(
    messageForRun({ firstRun: true, force: false, videos: all, newVideos: [] }),
    NOTHING_FOUND,
  );
  assert.equal(
    messageForRun({ firstRun: false, force: false, videos: all, newVideos: [] }),
    NOTHING_FOUND,
  );
  const onlyNew = messageForRun({
    firstRun: false,
    force: false,
    videos: all,
    newVideos: [all[1]],
  });
  assert.match(onlyNew, /Video Two/);
  assert.doesNotMatch(onlyNew, /Video One/);
});

test('splits long messages on line boundaries without losing content', () => {
  const text = Array.from(
    { length: 100 },
    (_, index) => `line ${index} ${'x'.repeat(60)}`,
  ).join('\n');

  const chunks = splitMessage(text, 1_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1_000);
  }
  assert.equal(chunks.join('\n'), text);
});

test('adds continuation markers to later chunks', () => {
  const text = Array.from(
    { length: 100 },
    (_, index) => `line ${index} ${'x'.repeat(60)}`,
  ).join('\n');

  const chunks = messageChunks(text, 1_000);
  assert.ok(chunks.length > 1);
  assert.doesNotMatch(chunks[0], /^\(تكملة/);
  assert.match(chunks[1], /^\(تكملة 2\/\d+\)\n/);
});
