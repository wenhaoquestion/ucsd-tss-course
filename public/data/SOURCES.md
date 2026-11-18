# Data sources and scope

## Winter 2027 courses and seats

The course catalog, teaching staff, published event-package memberships, meeting times, prerequisite text, restrictions and seat observations come from UC San Diego’s public Schedule of Classes. The static files contain the time the planner finished reading the public catalog in `observedAt`. The University may refresh individual sections on a different schedule. All timetable minutes are measured from midnight in San Diego. A dated meeting occurs only on the specified date. [UCSD Schedule of Classes](https://classplanner.apps.ucsd.edu/search) · [Public catalog request format](https://github.com/east-winds/ucsd-class-schedule-quickview#data-sources)

`catalog.json` groups offerings by course code. Each option uses an actual event-package membership. Some courses have no active published package in the snapshot. `starter.json` contains twelve courses from the same catalog, with identical option IDs. `seats.json` preserves the University’s separate count for each section. An option’s available count is the minimum reported across its component sections, or null if any component is unknown. Its capacity and waitlist refer to the identified `sectionId`, usually the package-specific discussion or lab. The minimum alone cannot establish enrollment eligibility.

The Nov 17 San Diego snapshot includes 2,307 course codes and 6,808 identifiable complete packages. It includes 129 packages with a waitlist-only component. The published component lists and complete-package counts identify incomplete memberships, such as a lecture whose discussion no longer appears. Nineteen course codes lack any complete package with a public package ID. Run `python scripts/data-verify.py` to check thirty fixed packages against the current public search. The included repeat observation covers 57 component memberships. Their dates, times, types and remote flags matched. Fourteen component seat counts changed in the twenty minutes between captures. The public source returned active and waitlist-only statuses during this check. A cancelled record was unavailable for direct verification. [Sample and observation times](./verification.json)

## Buildings and rooms

The November 5, 2026 public WI27 snapshot in Sahir Sharma’s WebReg Course Planner contains room assignments. A match requires the same course, official package ID, meeting type, day or dated exam, and exact start and end times. Ambiguous rooms within a group are omitted. The twelve starter courses also use package, event, day/date and time matches from the TSS++ public course API, which has more detailed location data for some meetings. A supplied TSS package link must point to the University’s HTTPS Fiori site. Classroom Explorer and TSS++ provide the building-name crosswalk. A room with a published building name can still lack a mapped walking route. [WI27 room archive](https://github.com/SahirSSharma/WebReg/tree/68de978591a6d80814fc9592f8ec9c9edf150d20/data/parsed/WI27) · [Archive snapshot date](https://github.com/SahirSSharma/WebReg/blob/68de978591a6d80814fc9592f8ec9c9edf150d20/data/refreshed_at.txt) · [TSS++ public API](https://github.com/alchin2/tssplusplus/blob/69f67dfaac8f89615266d67c891ceef02098fb01/backend/README.md) · [Classroom Explorer](https://github.com/wenhaoquestion/ucsd-classrooms)

The three community projects publish under MIT licenses. Their notices ship beside this document. UCSD provides the underlying schedule facts. The room sources have their own capture dates and can lag a room change that leaves the meeting time unchanged. [WebReg notice](./webreg-course-data-LICENSE.txt) · [TSS++ notice](./tssplusplus-LICENSE.txt) · [Classroom Explorer notice](./classroom-codes-LICENSE.txt)

The initial release locates at least one physical meeting for 1,605 courses and 3,696 packages. A full archive room can still have an unmatched code or a missing route endpoint.

## Course and professor statistics

The UCSD Historical Enrollment Data project published 61,791 aggregate CAPE records from summer 2007 through winter 2023. Of these, 44,593 report an actual GPA. The remaining rows can still report expected grades, hours or recommendations. The upstream `-1` missing value becomes JSON null. The course key and instructor label come from the archive. Multiple rows for one course, instructor and term can belong to different evaluations. [Pinned CAPE dataset](https://github.com/UCSD-Historical-Enrollment-Data/UCSDHistEnrollData/blob/d9348e4ba62350254dd6bea7e81aee3baf8f69cd/data/CAPEs.tsv) · [Dataset fields](https://github.com/UCSD-Historical-Enrollment-Data/UCSDHistEnrollData/tree/d9348e4ba62350254dd6bea7e81aee3baf8f69cd/data)

`actual` is the reported average grade received on a 4.0 scale. `expected` is the average students expected to receive. `hours` means study hours per week. `responses` counts evaluations submitted. `enrolled` counts course enrollment. `recommend` and `recommendCourse` are percentages from 0 to 100 for the instructor and course respectively. The sample size behind an actual GPA is unknown when the archive supplies only the enrollment and evaluation counts. The instructor index uses original labels and can contain name variants. Newer SET evaluations belong to a different reporting system. [UCSD SET](https://set.ucsd.edu/reports-responses/usingsetdata.html)

## Historical seats

The published WI24 and WI25 raw enrollment archives supply timestamped observations. For each winter the importer selects files at twelve offsets, from one day before the start of first pass through 23 days after. It reads the first observed sweep of distinct section identifiers in each selected file, within the first MiB. A file can omit a section or an entire date. Chart points carry their actual capture times. For the featured courses, available upstream course totals are sampled once per twelve-hour interval. Section labels belong to their original term. The course-total series has `section: null`. Its figures come from the archive’s course totals, which account for shared sections. [Archive methods](https://github.com/UCSD-Historical-Enrollment-Data/UCSDHistEnrollData/blob/master/docs/csv_info.md) · [WI24 source](https://github.com/UCSD-Historical-Enrollment-Data/2024Winter/tree/cdcbac11eb59bbbb71a71cae20f04a067e842501) · [WI25 source](https://github.com/UCSD-Historical-Enrollment-Data/2025Winter/tree/f69f79a44fc4728e69af848acf88aed4371abac9)

The archive’s MIT license expressly covers its data repositories. Credit goes to UCSD Historical Enrollment Data and its contributors. [License and citation request](https://github.com/UCSD-Historical-Enrollment-Data/UCSDHistEnrollData#license) · [Included notice](./historical-data-LICENSE.txt)

## Rebuild

Run the two standard-library Python 3 scripts from the project root. Course catalog generation reads the public current source. The grade and seat history scripts use fixed source revisions.

```sh
python scripts/data-catalog.py
python scripts/data-history.py
```

To resume a catalog build with the same observation timestamp, supply `--cache PATH`. A new empty cache or a run without that argument retrieves a fresh official observation. Historical datasets can be rebuilt separately with `python scripts/data-history.py grades` or `python scripts/data-history.py history`. The browser loads historical JSON by subject.
