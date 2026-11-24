-- 0016: the two-level category tree (ADR-018 §1; the owner's approval:
-- ADR-016 decisions 5, 29 and 31).
--
-- A category is a `departments` row (ADR-012 §1: a classification, not a
-- place). Additive only — no existing column, row, index or migration changes:
--
-- * `parent_id` — NULL for a main category; otherwise the main category it sits
--   under. Two levels, never three: the triggers below refuse a parent that is
--   itself a sub-category, and a parent for a category that already has one
--   under it. ON DELETE RESTRICT, like `products.department_id`: a category with
--   sub-categories cannot be deleted from under them.
-- * `kind` — how goods in the category are registered: `item` (counted, like
--   accessories), `phone` (device by device, with the IMEI) or `used` (second-hand
--   devices). A sub-category takes its parent's kind; the triggers below refuse
--   anything else. Existing rows become `item`.
-- * `icon` — the name of the category's icon, from the fixed list in the domain.
--   Existing rows take `tag`.
-- * `hidden` — 1 when the category's button is not shown on the sales screen.
--   Its goods stay in «الكل» and in search.
--
-- The order (`sort_order`) and the unique active name (`idx_departments_active_name`)
-- are 0004's and stay as they are: a name is unique across the whole tree.
--
-- The default categories are not inserted here: `created_by` must name a user,
-- and a fresh device has none yet. They are added with the first manager, and on
-- start-up for a database made before this migration (ADR-018 §1).

ALTER TABLE departments ADD COLUMN parent_id TEXT REFERENCES departments (id) ON DELETE RESTRICT;
ALTER TABLE departments ADD COLUMN kind TEXT NOT NULL DEFAULT 'item'
    CHECK (kind IN ('item', 'phone', 'used'));
ALTER TABLE departments ADD COLUMN icon TEXT NOT NULL DEFAULT 'tag'
    CHECK (length(icon) > 0);
ALTER TABLE departments ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
    CHECK (hidden IN (0, 1));

CREATE INDEX idx_departments_parent ON departments (parent_id);

-- Two levels: a new row's parent must be a main category, and never the row
-- itself. A parent that does not exist is left to the foreign key.
CREATE TRIGGER departments_tree_two_levels_insert
BEFORE INSERT ON departments
WHEN NEW.parent_id IS NOT NULL
 AND (NEW.parent_id = NEW.id
      OR (SELECT parent_id FROM departments WHERE id = NEW.parent_id) IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'category tree: the parent must be a main category');
END;

-- The same on a change of parent, and a category that has sub-categories
-- cannot itself move under another.
CREATE TRIGGER departments_tree_two_levels_update
BEFORE UPDATE OF parent_id ON departments
WHEN NEW.parent_id IS NOT NULL
 AND (NEW.parent_id = NEW.id
      OR (SELECT parent_id FROM departments WHERE id = NEW.parent_id) IS NOT NULL
      OR EXISTS (SELECT 1 FROM departments WHERE parent_id = NEW.id))
BEGIN
    SELECT RAISE(ABORT, 'category tree: the parent must be a main category');
END;

-- A sub-category is registered the way its parent is.
CREATE TRIGGER departments_tree_kind_insert
BEFORE INSERT ON departments
WHEN NEW.parent_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM departments WHERE id = NEW.parent_id)
 AND NEW.kind <> (SELECT kind FROM departments WHERE id = NEW.parent_id)
BEGIN
    SELECT RAISE(ABORT, 'category tree: a sub-category takes its parent''s kind');
END;

CREATE TRIGGER departments_tree_kind_update
BEFORE UPDATE OF kind, parent_id ON departments
WHEN (NEW.parent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM departments WHERE id = NEW.parent_id)
      AND NEW.kind <> (SELECT kind FROM departments WHERE id = NEW.parent_id))
  OR EXISTS (SELECT 1 FROM departments WHERE parent_id = NEW.id AND kind <> NEW.kind)
BEGIN
    SELECT RAISE(ABORT, 'category tree: a sub-category takes its parent''s kind');
END;
