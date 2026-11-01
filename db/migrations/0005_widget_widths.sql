-- Tiles are resized by dragging, a twelfth of the grid at a time: any width
-- from 1 to 12 columns, not only the halves, thirds and quarters offered before.
ALTER TABLE dashboard_widgets
  DROP CONSTRAINT dashboard_widgets_width_check,
  ADD CONSTRAINT dashboard_widgets_width_check CHECK (width BETWEEN 1 AND 12);
