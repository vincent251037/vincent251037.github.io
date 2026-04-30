import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'shared'))
from convert import main
main(os.path.dirname(os.path.abspath(__file__)))
