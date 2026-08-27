UPDATE runner_pools
SET trigger_label = replace(trigger_label, 'whitesmith', 'mars')
WHERE trigger_label LIKE '%whitesmith%';

UPDATE runner_pools
SET labels = (
  SELECT jsonb_agg(to_jsonb(replace(label, 'whitesmith', 'mars')))
  FROM jsonb_array_elements_text(labels) AS labels(label)
)
WHERE labels IS NOT NULL
  AND labels::text LIKE '%whitesmith%';
