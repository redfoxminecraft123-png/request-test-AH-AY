'use strict';

const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createApi } = require('../src/api');
const { collectVideos } = require('../src/collect');
const { buildNewVideosMessage } = require('../src/message');

async function main() {
  const config = loadConfig();
  const logger = createLogger('inspect');
  const api = createApi(config.api, logger);
  const showVideos = process.argv.includes('--videos');
  const showMessage = process.argv.includes('--message');

  try {
    await api.changeOnlineStatus(true);
    logger.info('Online status request succeeded.');
  } catch (error) {
    logger.warn(`Online status request failed: ${error.message}`);
  }

  const { teachers, videos, errors } = await collectVideos({
    api,
    teacherIds: config.api.teacherIds,
    logger,
  });

  console.log('');
  for (const teacher of teachers) {
    console.log(`Teacher: ${teacher.name} (id ${teacher.id})`);
    for (const course of teacher.courses) {
      const courseVideos = videos.filter((video) => video.courseId === course.id);
      console.log(`  Course: ${course.title} (id ${course.id}) - ${course.lessons.length} lesson(s), ${courseVideos.length} video(s)`);
      for (const lesson of course.lessons) {
        console.log(`    Lesson: ${lesson.title} (id ${lesson.id}) - ${lesson.videoCount} video(s)`);
        if (showVideos) {
          for (const video of videos.filter(
            (item) => item.courseId === course.id && item.lessonId === lesson.id,
          )) {
            console.log(`      - ${video.title}`);
            console.log(`        ${video.link}`);
          }
        }
      }
    }
    console.log('');
  }

  console.log(`Total: ${teachers.length} teacher(s), ${videos.length} video(s), ${errors.length} error(s).`);

  if (showMessage) {
    console.log('\n----- full message preview (all videos) -----\n');
    console.log(buildNewVideosMessage(videos));
    console.log('\n----- end preview -----\n');
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(
        `ERROR ${error.scope} ${error.id}${error.courseId ? ` (course ${error.courseId})` : ''}: ${error.message}`,
      );
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[inspect] ERROR ${error.message}`);
  process.exitCode = 1;
});
