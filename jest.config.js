/**
 * اختبارات الوحدة فقط — تعمل بلا قاعدة وبلا Docker.
 *
 * `testRegex` كان `'.*\.spec\.ts$'` بين علامتَي اقتباس عاديتين، فصار
 * `\.` مجرّد «أي حرف» وابتلع النمط `tenant-isolation.e2e-spec.ts`
 * أيضًا. النتيجة أن `npm test` كان يتطلّب قاعدة تعمل دون أن يُعلن
 * ذلك — ويفشل على أي جهاز لم يشغّل Docker.
 *
 * اختبارات الطرف إلى الطرف لها تهيئتها في `test/jest-e2e.json`
 * وتُشغَّل بـ`npm run test:e2e`.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  // `String.raw` لأن `'\.'` في سلسلة عادية يُفكّ إلى `.` — وهو
  // بالضبط ما أنتج الخطأ الموصوف أعلاه.
  testRegex: String.raw`\.spec\.ts$`,
  testPathIgnorePatterns: ['/node_modules/', '/test/'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};
