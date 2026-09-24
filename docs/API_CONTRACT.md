# Internal API contract v1

Local production http://127.0.0.1:47831. React frontend uses same origin.
GET /api/session returns {csrf:string}; cookie HttpOnly session. POST /api/rpc with X-CSRF-Token + JSON {tool:string,args:object}. Every response {ok:boolean,data?:any,error?:{code,message,details?},warnings:[],next_cursor:null|string}. Only show success when ok.
GET /api/download/:id downloads prepared export/backup using session.
MCP uses POST /api/mcp {tool,args} Authorization: Bearer token. UI-only tools strictly unavailable there. Token stored outside source data dir credentials.json {token}. GET /health is public version/ok only.

Common object ID string, revision integer, created_at updated_at ISO UTC, web_path hash route.
UI hash routes #courses, #course/<id>, #topic/<id>, #knowledge, #card/<id>, #notes, #note/<id>, #drafts, #draft/<id>, #settings, #import, #search?q=...

## Read tool results (data)

get_status {} => {app_version,schema_version,data_dir,counts:{courses,cards,notes,drafts},permissions,read_only,mode:'private'|'demo'}
get_agent_context {sections?:string[]} => {sections: Record<string,string>, available_materials, gaps}
get_schema {entity_type?:string} => JSON schemas
list_courses {query?,series?} => {items:[Course],series:[]}
get_course {course_id,revision?} => Course + {topics:Topic[],source_versions:Version[],learning_state:LearningState|null}
get_topic {topic_id,revision?} => Topic + {course:Course,knowledge_cards:Card[],learning_state,notes:Note[]} (notes only UI or granted MCP)
list_knowledge {query?,type?} => {items:Card[]}
get_knowledge_card {card_id,revision?} => Card + {topics:Topic[],notes:Note[],learning_state}
get_source_excerpt {source_version_id,source_block_id?,cursor?,limit?:1..20} => {source_document,source_version,blocks:SourceBlock[],next_cursor,total_blocks}; each block {id,source_document_id,source_version_id,order,title_path,text,line_start,line_end}; previous/next use cursor.
search_library {query,types?:string[],limit?,cursor?} => {items:[{id,type,title,snippet,source,web_path}],searched_scope,next_cursor}
list_notes {type?,relation_id?,limit?,cursor?} => {items:Note[],next_cursor}
get_note {note_id} => Note + {reviews:Review[],followups:Note[],relations:Relation[]}
list_drafts {} => {items:Draft[]}
get_draft_status {draft_id} => Draft + {current:object|null,proposed:object,validation:{warnings:[],errors:[]}}
list_audit {} => {items:Audit[]}
list_relations {} => {items:Relation[]}

Course {id,title,series,course_date:null|string,overview,revision,processing_status,verification_status,topic_count,source_version_ids:[],learning_state?}
Topic {id,course_id,parent_id:null|string,order,title,content_kind,blocks:TeachingBlock[],revision}
TeachingBlock {id,type,body_md,origin_kind,transformation,source_refs:SourceRef[],verification_status}
SourceRef {source_document_id,source_version_id,source_block_id}
Card {id,title,original_name,type,original_type,aliases:[],body_md,source_refs:[],topic_ids:[],verification_status,revision}
Note {id,original_text,type,created_at,updated_at,occurred_at:null|string,privacy:'private',author_type,relation_ids:[],parent_note_id:null|string,revision}
Review {id,note_ids:[],body_md,author_type,method_name:null|string,method_version:null|string,basis:[],gaps:[],created_at}
Draft {id,entity_type:'course'|'knowledge',entity_id,status:'draft'|'accepted'|'rejected'|'reverted',expected_revision,payload,created_at,revision}
LearningState {object_id,status,position:{topic_id?,scroll?},updated_at,revision}

## Shared write tools

create_note {original_text,type?:'quick'|'understanding'|'question'|'event'|'feedback'|'seed',relation_ids?:[],parent_note_id?,occurred_at?,client_request_id} => Note
save_review_result {note_ids:[],body_md,method_name?,method_version?,basis?:[],gaps?:[],client_request_id} => Review
propose_relations {relations:[{from_id,to_id,kind,reason?,source_refs?:[]}],client_request_id} => {items:Relation[]}
submit_course_draft {course_id?,title?,series?,course_date?,overview,expected_revision,source_version_ids:[],topics:Topic[],coverage:[],knowledge_candidates?:[],unresolved_questions?:[],client_request_id} => Draft (topic course_id optional)
submit_knowledge_draft {card_id?,title,type?,original_name?,original_type?,aliases?:[],body_md,source_refs:[],topic_ids?:[],verification_status?,expected_revision,client_request_id} => Draft

## UI-only writes

set_learning_state {object_id,status?,position?,expected_revision?} => LearningState
review_draft {draft_id,action:'accept'|'reject'|'revert',expected_revision,comparison_token?} => Draft (CSRF + UI session only; course acceptance requires current comparison token)
archive_note {note_id,expected_revision,archived:boolean} => Note
set_permissions {permissions:{read_library:boolean,append_notes:boolean,save_reviews:boolean,submit_courses:boolean,submit_knowledge:boolean,propose_relations:boolean,read_note_ids:string[]}} => permissions
rotate_mcp_token {} => {rotated:true}; adapter rereads credential file automatically. UI never needs raw secret.
review_relation {relation_id,status:'confirmed'|'rejected'} => Relation
preview_import {files:[{name,content_base64}],source_kind?:'cleaned_transcript'|'transcript'|'peer_summary'|'original_book'|'other',series?:string} => {id,items:[{name,type,status,sha256?,warnings:[]}],counts:{sources,courses,cards,cases,duplicates,unsupported},warnings:[]}
commit_import {preview_id} => {imported:[],skipped:[],drafts:[],warnings:[]}
export_data {scope:'all'|'course'|'knowledge'|'notes',ids?:string[],share?:boolean,redactions?:string[]} => {id,download_url,filename,preview, warnings:[]}; course excludes notes. UI show share preview prior download, redactions literal replacements.
create_backup {} => {id,download_url,filename,counts}
preview_restore {content_base64} => {id,counts,valid:true,warnings:[]}
commit_restore {preview_id,confirmation:'恢复此备份'} => {restored:true,previous_backup:string}

## v1.1 contract updates

The authoritative input schemas are `src/domain/contracts.ts`; the same strict Zod objects validate service calls and register MCP tools. `docs/TOOL_CONTRACTS.json` is generated input-schema documentation with `tsx scripts/export-schemas.ts`. Object schema version remains 1.0.0; application version is 1.1.0.

Lists accept `limit` (1..100) and zero-based `cursor`. Lists return summaries and `next_cursor`; use the detail tool for full text. Course maps return topic metadata; get_topic supplies the lecture. Read responses are capped at 2 MiB with an explicit PAYLOAD_TOO_LARGE response, never a silent replacement of stored text. Writes do not report failure merely because their returned payload is large after committing.

`list_notes` additionally accepts `from`, `to`, `include_archived`, `type`, `relation_id`. Dates are ISO calendar dates or timestamps with offsets; selected end dates include the whole day. `search_library` includes reviews and cases by default, supports dates and type aliases, and filters permissions before pagination. Review visibility requires every source note to be authorized. `get_review_result {review_id}` and `get_case {case_id}` open search results; since v1.2 both are also MCP read tools subject to the authorization rules below.

`get_note` resolves direct relation_ids and confirmed relationships into `resolved_relations` with object titles and web paths, filtered for the caller. `get_review_handoff {note_id,related_note_ids?,include_sources?}` is local-only, defaults to no additional notes or sources, and returns a preview package with capability gaps. It does not send to an external Agent automatically.

`cancel_import_preview {preview_id}` removes an uncommitted preview. Upload bytes live in bounded staging, not duplicate base64 blobs in SQLite options. Committed results remain idempotent; cancelled, failed and expired payloads are cleaned.

`export_data` returns immutable `parameters {scope,ids,share,redactions}` along with preview and file. A share operation redacts only designated textual fields; IDs, keys and reference structure remain unchanged. `create_backup {include_context?:boolean}` defaults false. A context-inclusive backup contains current versioned runtime context, never credentials.

GET `/health` includes `build {version,commit,fingerprint,lock_hash,built_at}` captured when the process starts, and an instance identifier. It does not reveal the data directory or credentials.

## v1.2 second-review contracts

Application version is 1.2.0; database and object schema versions remain unchanged. MCP now exposes **23 tools**, adding `get_case {case_id}` and `get_review_result {review_id}`. Case reads require library permission and case-specific note scope. Review reads require authorization for every associated note, independently of library permission. Search IDs can be followed through these tools to full content and then fixed source excerpts or original notes.

Web calendar filters use the browser's local timezone. `src/web/dates.ts` converts a selected day to an inclusive ISO `from` and the next local midnight as exclusive ISO `to_exclusive`; the duration may be 23 or 25 hours across DST. Both `list_notes` and `search_library` accept this half-open interval. Explicit timestamps are instants; legacy date-only `from`/`to` retain UTC-day semantics for API compatibility, so clients needing a local day must send the converted interval. `to` and `to_exclusive` cannot both be supplied. Note filtering and ordering use `occurred_at ?? created_at`; the UI labels the chosen basis and separately retains creation time. Missing occurrence times stay null.

`set_learning_state.position` uses `topic_id` plus `teaching_block_id`, optional `block_offset` and `scroll`. The teaching anchor must belong to the specified topic and course. Legacy `block_id` is accepted only when it resolves to a teaching block in that topic, including a genuine source reference there. Legacy teaching blocks without IDs receive deterministic read IDs; no arbitrary global ID is accepted.

Local-only `get_draft_comparison {draft_id}` returns complete `current_course/current_topics` and `proposed_course/proposed_topics`, the draft/current/topic revisions, `ready`, and `comparison_token`. It applies the existing 2 MiB read cap without truncation. Course `review_draft(action:accept)` must include that token; absent, changed or stale comparisons are rejected inside the transaction. Regular course/map reads remain summaries. Knowledge drafts retain their existing full-body comparison.

Local-only `get_review_handoff` additionally accepts `review_ids`, `feedback_note_ids` and `method_intent` (`general_review` or `heijin_review`). Included reviews must refer only to the explicitly selected notes, and feedback must belong to that note set. The result reports exact `selected` parameters, both timestamps, fixed source IDs, `source_summary {total_refs,attached_count,omitted_refs,truncated_refs}` and separate workbench/receiver capability states. Source text remains limited to ten excerpts of at most 12000 characters, with omitted and truncated references declared. This operation creates a preview, never sends it externally. The web client invalidates in-flight and completed previews on any scope change.

Direct `relation_ids` and confirmed relations share the same visibility rules in record details, inverse topic/card notes, relation filtering and handoff source collection. Pending/rejected or out-of-scope relations cannot act as confirmed links. Course summaries retain `processing_status`; card summaries retain `verification_status`.
