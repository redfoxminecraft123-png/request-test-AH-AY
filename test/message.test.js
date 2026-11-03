'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  messagesForRun,
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
  assert.deepEqual(
    messagesForRun({ firstRun: false, force: true, videos: [], newVideos: [] }),
    [NOTHING_FOUND],
  );
  assert.deepEqual(
    messagesForRun({ firstRun: false, force: false, videos: [], newVideos: [] }),
    [NOTHING_FOUND],
  );
});

test('sends one message per teacher, grouped by course and lesson', () => {
  const messages = messagesForRun({
    firstRun: false,
    force: false,
    videos: [],
    newVideos: [
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
    ],
  });

  assert.equal(messages.length, 2);

  const [one, two] = messages;
  assert.ok(one.startsWith(NEW_HEADER));
  assert.ok(two.startsWith(NEW_HEADER));
  assert.match(one, /\*Teacher One\*/);
  assert.match(one, /\*Course One\*/);
  assert.match(one, /Lesson One:/);
  assert.match(one, /- First video\nhttps:\/\/example\.com\/one/);
  assert.match(one, /- Second video\nhttps:\/\/example\.com\/two/);
  assert.doesNotMatch(one, /Teacher Two|Third video/);
  assert.match(two, /\*Teacher Two\*/);
  assert.match(two, /- Third video\nhttps:\/\/example\.com\/three/);
  assert.doesNotMatch(two, /Teacher One|First video/);

  assert.ok(one.indexOf('First video') < one.indexOf('Second video'));
});

test('force send lists every video of each teacher', () => {
  const all = [
    video({ sessionId: '1' }),
    video({ sessionId: '2', title: 'Video Two' }),
    video({ sessionId: '3', teacherId: 2, teacherName: 'Teacher Two', title: 'Video Three' }),
  ];
  const messages = messagesForRun({ firstRun: false, force: true, videos: all, newVideos: [] });

  assert.equal(messages.length, 2);
  assert.match(messages[0], /Video One/);
  assert.match(messages[0], /Video Two/);
  assert.match(messages[1], /Video Three/);
  assert.doesNotMatch(messages[1], /Video One/);
});

test('splits a teacher into parts of 50 videos', () => {
  const many = Array.from({ length: 51 }, (_, index) =>
    video({
      sessionId: String(index + 1),
      title: `Video ${index + 1}`,
      link: `https://example.com/${index + 1}`,
    }),
  );
  many.push(
    video({
      sessionId: '999',
      teacherId: 2,
      teacherName: 'Teacher Two',
      title: 'Other video',
      link: 'https://example.com/other',
    }),
  );

  const messages = messagesForRun({
    firstRun: false,
    force: true,
    videos: many,
    newVideos: [],
  });

  assert.equal(messages.length, 3);
  for (const message of messages) assert.ok(message.startsWith(NEW_HEADER));

  assert.match(messages[0], /\*Teacher One - part 1\*/);
  assert.match(messages[1], /\*Teacher One - part 2\*/);
  assert.equal((messages[0].match(/https:\/\//g) || []).length, 50);
  assert.equal((messages[1].match(/https:\/\//g) || []).length, 1);
  assert.match(messages[2], /\*Teacher Two\*/);
  assert.doesNotMatch(messages[2], /part/);
});

test('normal runs keep the nothing-found and new-only behaviour', () => {
  const all = [video({ sessionId: '1' }), video({ sessionId: '2', title: 'Video Two' })];
  assert.deepEqual(
    messagesForRun({ firstRun: true, force: false, videos: all, newVideos: [] }),
    [NOTHING_FOUND],
  );
  assert.deepEqual(
    messagesForRun({ firstRun: false, force: false, videos: all, newVideos: [] }),
    [NOTHING_FOUND],
  );

  const onlyNew = messagesForRun({
    firstRun: false,
    force: false,
    videos: all,
    newVideos: [all[1]],
  });
  assert.equal(onlyNew.length, 1);
  assert.match(onlyNew[0], /Video Two/);
  assert.doesNotMatch(onlyNew[0], /Video One/);
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
