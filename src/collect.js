'use strict';

function dedupeCourses(courses, revisions) {
  const byId = new Map();
  for (const course of [...(Array.isArray(courses) ? courses : []), ...(Array.isArray(revisions) ? revisions : [])]) {
    if (!course || course.id === undefined || course.id === null) continue;
    const id = Number(course.id);
    if (!byId.has(id)) byId.set(id, course);
  }
  return [...byId.values()];
}

function extractLessons(courseData) {
  const lessons = [];
  const seen = new Set();

  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const lesson of list) {
      if (!lesson || lesson.id === undefined || lesson.id === null) continue;
      const id = Number(lesson.id);
      if (seen.has(id)) continue;
      seen.add(id);
      lessons.push(lesson);
    }
  };

  add(courseData.lessons);
  for (const unit of Array.isArray(courseData.units) ? courseData.units : []) {
    if (!unit || typeof unit !== 'object') continue;
    add(unit.lessons);
  }

  return lessons;
}

function toVideo(session, context) {
  const link = session.link || session.external_link || '';
  return {
    sessionId: String(session.id),
    teacherId: context.teacherId,
    teacherName: context.teacherName,
    courseId: context.courseId,
    courseTitle: context.courseTitle,
    lessonId: context.lessonId,
    lessonTitle: context.lessonTitle,
    title: session.title || 'بدون عنوان',
    link: String(link),
    addedAt: session.updated_at || session.created_at || null,
  };
}

async function collectVideos({ api, teacherIds, logger }) {
  const teachers = [];
  const videosById = new Map();
  const errors = [];

  for (const teacherId of teacherIds) {
    let teacherData;
    try {
      teacherData = await api.fetchTeacherDetails(teacherId);
    } catch (error) {
      errors.push({ scope: 'teacher', id: teacherId, message: error.message });
      logger.error(`Could not fetch teacher ${teacherId}: ${error.message}`);
      continue;
    }

    const data = teacherData.data || {};
    const teacher = {
      id: Number(data.id || teacherId),
      name: data.name || `مدرس ${teacherId}`,
      courses: [],
    };

    const courses = dedupeCourses(data.courses, data.revisions);
    logger.info(`Teacher ${teacher.id} (${teacher.name}): ${courses.length} course(s)/revision(s)`);

    for (const course of courses) {
      const courseId = Number(course.id);
      let courseData;
      try {
        const response = await api.fetchCourseDetails(courseId);
        courseData = response.data || {};
      } catch (error) {
        errors.push({ scope: 'course', id: courseId, message: error.message });
        logger.error(`  Could not fetch course ${courseId}: ${error.message}`);
        continue;
      }

      const courseTitle =
        (courseData.course_info && courseData.course_info.title) ||
        course.title ||
        `كورس ${courseId}`;
      const lessons = extractLessons(courseData);
      const courseEntry = { id: courseId, title: courseTitle, lessons: [] };

      for (const lesson of lessons) {
        const lessonId = Number(lesson.id);
        let lessonData;
        try {
          const response = await api.fetchLessonSessions(lessonId, courseId);
          lessonData = response.data || {};
        } catch (error) {
          errors.push({
            scope: 'lesson',
            id: lessonId,
            courseId,
            message: error.message,
          });
          logger.error(`    Could not fetch lesson ${lessonId} in course ${courseId}: ${error.message}`);
          continue;
        }

        const lessonTitle = lessonData.title || lesson.title || `درس ${lessonId}`;
        const sessions = Array.isArray(lessonData.sessions) ? lessonData.sessions : [];
        const lessonVideos = [];

        for (const session of sessions) {
          if (!session || session.id === undefined || session.id === null) continue;
          if (Number(session.type) !== 1) continue;
          if (!session.link && !session.external_link) continue;

          const video = toVideo(session, {
            teacherId: teacher.id,
            teacherName: teacher.name,
            courseId,
            courseTitle,
            lessonId,
            lessonTitle,
          });

          if (!videosById.has(video.sessionId)) {
            videosById.set(video.sessionId, video);
            lessonVideos.push(video);
          }
        }

        if (lessonVideos.length > 0) {
          courseEntry.lessons.push({
            id: lessonId,
            title: lessonTitle,
            videoCount: lessonVideos.length,
          });
        }
      }

      teacher.courses.push(courseEntry);
    }

    teachers.push(teacher);
  }

  return {
    teachers,
    videos: [...videosById.values()],
    errors,
  };
}

module.exports = { collectVideos, extractLessons, dedupeCourses };
