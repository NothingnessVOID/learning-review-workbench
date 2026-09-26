/**
 * Two integration regression TEMPLATES for learning-review-workbench 1848d516.
 * Not executed in the review environment (repository dependency network unavailable).
 * Copy into the repository tests/ and run with its supported Node/runtime.
 * These assert desired fixed behavior; the current implementation is expected to fail.
 * Uses only an automatically cleaned temporary database and synthetic records.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../src/domain/service.js';
import { handoffMarkdown } from '../src/web/handoff.js';

test('C01: opening an unrelated topic must not reload the notes table once per note', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-third-review-'));
  const service = new Service(dir, process.cwd());
  try {
    service.store.tx(() => {
      service.store.put('courses', {
        id:'course_third_demo',title:'SYNTHETIC course',series:'SYNTHETIC',
        course_date:null,overview:'Synthetic performance fixture',source_version_ids:[],topic_count:1
      },0);
      service.store.put('topics', {
        id:'topic_third_demo',course_id:'course_third_demo',parent_id:null,
        title:'SYNTHETIC unrelated topic',order:0,content_kind:'lesson',blocks:[]
      },0);
      for (let index=0;index<80;index++) service.store.put('notes', {
        id:`note_third_${index}`,original_text:'SYNTHETIC private note without links',
        type:'quick',privacy:'private',author_type:'local_user',relation_ids:[],
        parent_note_id:null,occurred_at:null
      },0);
    });
    const originalAll=service.store.all.bind(service.store);
    let noteTableReads=0;
    service.store.all=((table:any,includeArchived=false)=>{
      if(table==='notes') noteTableReads++;
      return originalAll(table,includeArchived);
    }) as typeof service.store.all;
    const response:any=await service.invoke('get_topic',{topic_id:'topic_third_demo'},'local_user');
    assert.equal(response.ok,true,JSON.stringify(response.error));
    assert.deepEqual(response.data.notes,[]);
    // This operation-count guard is intentionally not a wall-clock SLA.
    assert.ok(noteTableReads<=8,`notes table loaded ${noteTableReads} times for 80 unrelated notes`);
  } finally {
    service.store.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('C04: selected historical review keeps its unresolved gaps and permitted basis in handoff', () => {
  const selection:any={note_id:'note_third_main',related_note_ids:[],review_ids:['review_third_old'],feedback_note_ids:[],include_sources:false,method_intent:'general_review'};
  const result:any={
    note:{id:'note_third_main',original_text:'SYNTHETIC original event',occurred_at:null,created_at:'2026-09-24T00:00:00Z'},
    related_notes:[],feedback_notes:[],source_refs:[],source_excerpts:[],
    reviews:[{id:'review_third_old',note_ids:['note_third_main'],body_md:'SYNTHETIC past interpretation',created_at:'2026-09-24T01:00:00Z',method_name:null,method_version:null,author_type:'external_agent',gaps:['UNVERIFIED_SYNTHETIC_FACT'],basis:['PERMITTED_SYNTHETIC_BASIS']}],
    gaps:['GENERIC_WORKBENCH_LIMIT'],selected:{...selection}
  };
  const output=handoffMarkdown(result,selection);
  assert.ok(output.includes('SYNTHETIC past interpretation'));
  assert.ok(output.includes('UNVERIFIED_SYNTHETIC_FACT'),'Do not lose a selected review-specific uncertainty');
  assert.ok(output.includes('PERMITTED_SYNTHETIC_BASIS'),'Preserve already-authorized basis, or explicitly explain omissions');
});
